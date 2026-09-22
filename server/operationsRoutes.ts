import { Router } from 'express';
import type { PoolClient } from 'pg';
import { requireUser } from './auth.js';
import { firstRow, withActorTransaction } from './database.js';
import { organizationIdParamsSchema, type OrganizationRole } from './schemas.js';
import { createProjectSchema, createPropertySchema, idParamsSchema, projectListQuerySchema, propertyListQuerySchema, updatePropertySchema } from './operationsSchemas.js';

export const operationsRouter = Router();

async function requireRole(client: PoolClient, organizationId: string, userId: string, roles: OrganizationRole[]) {
  const result = await client.query<{ role: OrganizationRole }>('select role from public.organization_memberships where organization_id=$1 and user_id=$2 and is_active=true', [organizationId, userId]);
  if (!result.rows[0] || !roles.includes(result.rows[0].role)) { const error = new Error('You do not have permission for this operation') as Error & { status?: number }; error.status = 403; throw error; }
}

operationsRouter.get('/dashboard', async (request, response) => {
  const user = requireUser(request);
  const organizationId = organizationIdParamsSchema.parse(request.query);
  const data = await withActorTransaction(user.id, async (client) => {
    const counts = await client.query<{ total: string; active: string; negotiation: string; blocked: string; ready: string }>(`
      select count(*) filter (where status='active') as total,
             count(*) filter (where acquisition_status='active') as active,
             count(*) filter (where acquisition_stage='negotiation') as negotiation,
             count(*) filter (where legal_status='blocked' or risk='high') as blocked,
             count(*) filter (where readiness_percent >= 80 and acquisition_status='active') as ready
        from public.properties where organization_id=$1`, [organizationId.organizationId]);
    const stages = await client.query<{ acquisition_stage: string; count: string }>(`select acquisition_stage, count(*) from public.properties where organization_id=$1 and acquisition_status='active' group by acquisition_stage order by acquisition_stage`, [organizationId.organizationId]);
    return { ...counts.rows[0], stages: stages.rows };
  });
  response.json({ data });
});

operationsRouter.get('/projects', async (request, response) => {
  const user = requireUser(request);
  const { organizationId } = projectListQuerySchema.parse(request.query);
  const projects = await withActorTransaction(user.id, async (client) => (await client.query(`select id, organization_id, code, name, description, status, acquisition_target, manager_user_id, starts_on, target_completion_on, created_at, updated_at from public.projects where organization_id=$1 order by created_at desc`, [organizationId])).rows);
  response.json({ data: projects });
});

operationsRouter.post('/projects', async (request, response) => {
  const user = requireUser(request);
  const body = createProjectSchema.parse(request.body);
  const project = await withActorTransaction(user.id, async (client) => {
    await requireRole(client, body.organizationId, user.id, ['system_admin','land_acquisition_manager']);
    const result = await client.query(`insert into public.projects (organization_id, code, name, description, status, acquisition_target, manager_user_id, starts_on, target_completion_on) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`, [body.organizationId, body.code, body.name, body.description ?? null, body.status, body.acquisitionTarget ?? null, body.managerUserId ?? null, body.startsOn ?? null, body.targetCompletionOn ?? null]);
    return firstRow(result.rows, 'Project creation failed');
  });
  response.status(201).json({ data: project });
});

operationsRouter.get('/properties', async (request, response) => {
  const user = requireUser(request);
  const query = propertyListQuerySchema.parse(request.query);
  const properties = await withActorTransaction(user.id, async (client) => {
    const values: unknown[] = [query.organizationId];
    const where = ['p.organization_id=$1'];
    if (query.projectId) { values.push(query.projectId); where.push(`p.project_id=$${values.length}`); }
    if (query.stage) { values.push(query.stage); where.push(`p.acquisition_stage=$${values.length}`); }
    if (query.search) { values.push(`%${query.search}%`); where.push(`(p.property_reference ilike $${values.length} or coalesce(p.lot_number,'') ilike $${values.length} or coalesce(p.municipality,'') ilike $${values.length} or coalesce(p.barangay,'') ilike $${values.length})`); }
    values.push(query.limit, query.offset);
    const result = await client.query(`select p.*, pr.code as project_code, pr.name as project_name, u.display_name as negotiator_name from public.properties p join public.projects pr on pr.id=p.project_id left join public.app_users u on u.id=p.assigned_negotiator_id where ${where.join(' and ')} order by p.updated_at desc limit $${values.length-1} offset $${values.length}`, values);
    return result.rows;
  });
  response.json({ data: properties });
});

operationsRouter.get('/properties/:id', async (request, response) => {
  const user = requireUser(request);
  const { id } = idParamsSchema.parse(request.params);
  const property = await withActorTransaction(user.id, async (client) => {
    const result = await client.query(`select p.*, pr.code as project_code, pr.name as project_name, u.display_name as negotiator_name, m.display_name as manager_name from public.properties p join public.projects pr on pr.id=p.project_id left join public.app_users u on u.id=p.assigned_negotiator_id left join public.app_users m on m.id=p.assigned_manager_id where p.id=$1`, [id]);
    return firstRow(result.rows, 'Property not found');
  });
  response.json({ data: property });
});

operationsRouter.post('/properties', async (request, response) => {
  const user = requireUser(request);
  const body = createPropertySchema.parse(request.body);
  const property = await withActorTransaction(user.id, async (client) => {
    await requireRole(client, body.organizationId, user.id, ['system_admin','land_acquisition_manager']);
    const result = await client.query(`insert into public.properties (organization_id, project_id, property_reference, title_number, tax_declaration, lot_number, area_hectares, municipality, province, barangay, acquisition_stage, assigned_negotiator_id, assigned_manager_id, risk) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`, [body.organizationId, body.projectId, body.propertyReference, body.titleNumber ?? null, body.taxDeclaration ?? null, body.lotNumber ?? null, body.areaHectares ?? null, body.municipality ?? null, body.province ?? null, body.barangay ?? null, body.acquisitionStage, body.assignedNegotiatorId ?? null, body.assignedManagerId ?? null, body.risk]);
    return firstRow(result.rows, 'Property creation failed');
  });
  response.status(201).json({ data: property });
});

operationsRouter.patch('/properties/:id', async (request, response) => {
  const user = requireUser(request);
  const { id } = idParamsSchema.parse(request.params);
  const body = updatePropertySchema.parse(request.body);
  const property = await withActorTransaction(user.id, async (client) => {
    const existing = await firstRow((await client.query(`select * from public.properties where id=$1`, [id])).rows, 'Property not found');
    await requireRole(client, existing.organization_id, user.id, ['system_admin','land_acquisition_manager','supervisor','legal_documentation','finance']);
    const fields: Record<string, string> = { acquisitionStage:'acquisition_stage', acquisitionStatus:'acquisition_status', titleNumber:'title_number', taxDeclaration:'tax_declaration', lotNumber:'lot_number', areaHectares:'area_hectares', municipality:'municipality', province:'province', barangay:'barangay', assignedNegotiatorId:'assigned_negotiator_id', assignedManagerId:'assigned_manager_id', legalStatus:'legal_status', documentationStatus:'documentation_status', paymentStatus:'payment_status', readinessPercent:'readiness_percent', risk:'risk' };
    const sets: string[] = []; const values: unknown[] = [];
    for (const [key, column] of Object.entries(fields)) if (body[key as keyof typeof body] !== undefined) { values.push(body[key as keyof typeof body]); sets.push(`${column}=$${values.length}`); }
    if (!sets.length) return existing;
    values.push(id);
    const result = await client.query(`update public.properties set ${sets.join(', ')} where id=$${values.length} returning *`, values);
    return firstRow(result.rows, 'Property update failed');
  });
  response.json({ data: property });
});

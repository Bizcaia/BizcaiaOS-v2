import { Router } from 'express';
import type { PoolClient } from 'pg';
import { requireUser } from './auth.js';
import { firstRow, withActorTransaction } from './database.js';
import { organizationIdParamsSchema, type OrganizationRole } from './schemas.js';
import {
  createOwnerSchema,
  createProjectSchema,
  createPropertySchema,
  idParamsSchema,
  linkOwnerSchema,
  ownerListQuerySchema,
  projectListQuerySchema,
  propertyListQuerySchema,
  propertyOwnerParamsSchema,
  createNegotiationEventSchema,
  createNegotiationSchema,
  negotiationListQuerySchema,
  updateNegotiationSchema,
  updatePropertySchema,
} from './operationsSchemas.js';

export const operationsRouter = Router();

const OWNER_MANAGER_ROLES: OrganizationRole[] = ['system_admin', 'land_acquisition_manager'];
const PROPERTY_CREATE_ROLES: OrganizationRole[] = ['system_admin', 'land_acquisition_manager'];
const NEGOTIATION_MANAGER_ROLES: OrganizationRole[] = ['system_admin', 'land_acquisition_manager'];

const negotiationPatchColumns: Record<string, string> = {
  status: 'status',
  assignedNegotiatorId: 'assigned_negotiator_id',
  openingAmount: 'opening_amount',
  targetAmount: 'target_amount',
  currencyCode: 'currency_code',
  startedAt: 'started_at',
  closedAt: 'closed_at',
  archivedAt: 'archived_at',
};

function allowedNegotiationPatchKeys(role: OrganizationRole): Set<string> {
  if (NEGOTIATION_MANAGER_ROLES.includes(role)) {
    return new Set(Object.keys(negotiationPatchColumns));
  }
  if (role === 'negotiator') {
    return new Set(['status', 'openingAmount', 'targetAmount', 'currencyCode', 'startedAt', 'closedAt', 'archivedAt']);
  }
  return new Set();
}

function canWriteNegotiation(role: OrganizationRole, assignedNegotiatorId: string | null, userId: string) {
  if (NEGOTIATION_MANAGER_ROLES.includes(role)) return true;
  return role === 'negotiator' && assignedNegotiatorId === userId;
}

const propertyPatchColumns: Record<string, string> = {
  acquisitionStage: 'acquisition_stage',
  acquisitionStatus: 'acquisition_status',
  titleNumber: 'title_number',
  taxDeclaration: 'tax_declaration',
  lotNumber: 'lot_number',
  areaHectares: 'area_hectares',
  municipality: 'municipality',
  province: 'province',
  barangay: 'barangay',
  assignedNegotiatorId: 'assigned_negotiator_id',
  assignedManagerId: 'assigned_manager_id',
  legalStatus: 'legal_status',
  documentationStatus: 'documentation_status',
  paymentStatus: 'payment_status',
  readinessPercent: 'readiness_percent',
  risk: 'risk',
  metadata: 'metadata',
};

function allowedPropertyPatchKeys(role: OrganizationRole): Set<string> {
  switch (role) {
    case 'system_admin':
    case 'land_acquisition_manager':
      return new Set(Object.keys(propertyPatchColumns));
    case 'supervisor':
      return new Set(['readinessPercent', 'risk', 'metadata']);
    case 'legal_documentation':
      return new Set(['legalStatus', 'documentationStatus']);
    case 'finance':
      return new Set(['paymentStatus']);
    default:
      return new Set();
  }
}

function httpError(status: number, message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

async function requireMembership(client: PoolClient, organizationId: string, userId: string) {
  const role = await currentRole(client, organizationId, userId);
  if (!role) throw httpError(403, 'You do not have permission for this operation');
  return role;
}

async function requireVisibleProperty(
  client: PoolClient,
  organizationId: string,
  userId: string,
) {
  const role = await currentRole(client, organizationId, userId);
  if (!role) throw httpError(404, 'Property not found');
  return role;
}

async function requireRole(
  client: PoolClient,
  organizationId: string,
  userId: string,
  roles: OrganizationRole[],
) {
  const role = await requireMembership(client, organizationId, userId);
  if (!roles.includes(role)) {
    throw httpError(403, 'You do not have permission for this operation');
  }
  return role;
}

async function currentRole(client: PoolClient, organizationId: string, userId: string) {
  const result = await client.query<{ role: OrganizationRole }>(
    `select role
       from public.organization_memberships
      where organization_id = $1
        and user_id = $2
        and is_active = true`,
    [organizationId, userId],
  );
  return result.rows[0]?.role;
}

const propertySelect = `
  select p.*, pr.code as project_code, pr.name as project_name,
         u.display_name as negotiator_name, m.display_name as manager_name
    from public.properties p
    join public.projects pr on pr.id = p.project_id
    left join public.app_users u on u.id = p.assigned_negotiator_id
    left join public.app_users m on m.id = p.assigned_manager_id`;

async function listPropertyOwners(client: PoolClient, propertyId: string) {
  const result = await client.query(
    `select po.owner_id, o.display_name, o.owner_type, po.ownership_percent,
            po.is_primary, o.contact_details
       from public.property_owners po
       join public.owners o on o.id = po.owner_id
      where po.property_id = $1
      order by po.is_primary desc, o.display_name`,
    [propertyId],
  );
  return result.rows;
}

operationsRouter.get('/dashboard', async (request, response) => {
  const user = requireUser(request);
  const organizationId = organizationIdParamsSchema.parse(request.query);
  const data = await withActorTransaction(user.id, async (client) => {
    await requireMembership(client, organizationId.organizationId, user.id);
    const counts = await client.query<{ total: string; active: string; negotiation: string; blocked: string; ready: string }>(`
      select count(*) filter (where status='active') as total,
             count(*) filter (where acquisition_status='active') as active,
             count(*) filter (where acquisition_stage='negotiation') as negotiation,
             count(*) filter (where legal_status='blocked' or risk='high') as blocked,
             count(*) filter (where readiness_percent >= 80 and acquisition_status='active') as ready
        from public.properties where organization_id=$1`, [organizationId.organizationId]);
    const stages = await client.query<{ acquisition_stage: string; count: string }>(
      `select acquisition_stage, count(*) from public.properties where organization_id=$1 and acquisition_status='active' group by acquisition_stage order by acquisition_stage`,
      [organizationId.organizationId],
    );
    return { ...counts.rows[0], stages: stages.rows };
  });
  response.json({ data });
});

operationsRouter.get('/projects', async (request, response) => {
  const user = requireUser(request);
  const { organizationId } = projectListQuerySchema.parse(request.query);
  const projects = await withActorTransaction(user.id, async (client) => {
    await requireMembership(client, organizationId, user.id);
    return (await client.query(
      `select id, organization_id, code, name, description, status, acquisition_target, manager_user_id, starts_on, target_completion_on, created_at, updated_at
         from public.projects where organization_id=$1 order by created_at desc`,
      [organizationId],
    )).rows;
  });
  response.json({ data: projects });
});

operationsRouter.post('/projects', async (request, response) => {
  const user = requireUser(request);
  const body = createProjectSchema.parse(request.body);
  const project = await withActorTransaction(user.id, async (client) => {
    await requireRole(client, body.organizationId, user.id, PROPERTY_CREATE_ROLES);
    const result = await client.query(
      `insert into public.projects (organization_id, code, name, description, status, acquisition_target, manager_user_id, starts_on, target_completion_on)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [body.organizationId, body.code, body.name, body.description ?? null, body.status, body.acquisitionTarget ?? null, body.managerUserId ?? null, body.startsOn ?? null, body.targetCompletionOn ?? null],
    );
    return firstRow(result.rows, 'Project creation failed');
  });
  response.status(201).json({ data: project });
});

operationsRouter.get('/owners', async (request, response) => {
  const user = requireUser(request);
  const { organizationId } = ownerListQuerySchema.parse(request.query);
  const owners = await withActorTransaction(user.id, async (client) => {
    await requireMembership(client, organizationId, user.id);
    return (await client.query(
      `select id, organization_id, owner_type, display_name, organization_name, contact_details, created_at, updated_at
         from public.owners where organization_id=$1 order by display_name`,
      [organizationId],
    )).rows;
  });
  response.json({ data: owners });
});

operationsRouter.post('/owners', async (request, response) => {
  const user = requireUser(request);
  const body = createOwnerSchema.parse(request.body);
  const owner = await withActorTransaction(user.id, async (client) => {
    await requireRole(client, body.organizationId, user.id, OWNER_MANAGER_ROLES);
    const result = await client.query(
      `insert into public.owners (organization_id, owner_type, display_name, organization_name, contact_details)
       values ($1,$2,$3,$4,$5) returning *`,
      [body.organizationId, body.ownerType, body.displayName, body.organizationName ?? null, JSON.stringify(body.contactDetails ?? {})],
    );
    return firstRow(result.rows, 'Owner creation failed');
  });
  response.status(201).json({ data: owner });
});

operationsRouter.get('/properties', async (request, response) => {
  const user = requireUser(request);
  const query = propertyListQuerySchema.parse(request.query);
  const properties = await withActorTransaction(user.id, async (client) => {
    await requireMembership(client, query.organizationId, user.id);
    const values: unknown[] = [query.organizationId];
    const where = ['p.organization_id=$1'];
    if (query.projectId) { values.push(query.projectId); where.push(`p.project_id=$${values.length}`); }
    if (query.stage) { values.push(query.stage); where.push(`p.acquisition_stage=$${values.length}`); }
    if (query.search) {
      values.push(`%${query.search}%`);
      where.push(`(p.property_reference ilike $${values.length} or coalesce(p.lot_number,'') ilike $${values.length} or coalesce(p.municipality,'') ilike $${values.length} or coalesce(p.barangay,'') ilike $${values.length})`);
    }
    values.push(query.limit, query.offset);
    const result = await client.query(
      `${propertySelect} where ${where.join(' and ')} order by p.updated_at desc limit $${values.length - 1} offset $${values.length}`,
      values,
    );
    return result.rows;
  });
  response.json({ data: properties });
});

operationsRouter.get('/properties/:id', async (request, response) => {
  const user = requireUser(request);
  const { id } = idParamsSchema.parse(request.params);
  const property = await withActorTransaction(user.id, async (client) => {
    const result = await client.query(`${propertySelect} where p.id=$1`, [id]);
    const row = firstRow(result.rows, 'Property not found');
    if (!(await currentRole(client, row.organization_id, user.id))) {
      throw httpError(404, 'Property not found');
    }
    const owners = await listPropertyOwners(client, id);
    return { ...row, owners };
  });
  response.json({ data: property });
});

operationsRouter.post('/properties', async (request, response) => {
  const user = requireUser(request);
  const body = createPropertySchema.parse(request.body);
  const property = await withActorTransaction(user.id, async (client) => {
    await requireRole(client, body.organizationId, user.id, PROPERTY_CREATE_ROLES);
    const project = firstRow(
      (await client.query<{ organization_id: string }>(`select organization_id from public.projects where id=$1`, [body.projectId])).rows,
      'Project not found',
    );
    if (project.organization_id !== body.organizationId) {
      throw httpError(422, 'Property project must belong to the same organization');
    }
    const result = await client.query(
      `insert into public.properties (organization_id, project_id, property_reference, title_number, tax_declaration, lot_number, area_hectares, municipality, province, barangay, acquisition_stage, assigned_negotiator_id, assigned_manager_id, risk)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
      [body.organizationId, body.projectId, body.propertyReference, body.titleNumber ?? null, body.taxDeclaration ?? null, body.lotNumber ?? null, body.areaHectares ?? null, body.municipality ?? null, body.province ?? null, body.barangay ?? null, body.acquisitionStage, body.assignedNegotiatorId ?? null, body.assignedManagerId ?? null, body.risk],
    );
    return firstRow(result.rows, 'Property creation failed');
  });
  response.status(201).json({ data: property });
});

operationsRouter.patch('/properties/:id', async (request, response) => {
  const user = requireUser(request);
  const { id } = idParamsSchema.parse(request.params);
  const body = updatePropertySchema.parse(request.body);
  const property = await withActorTransaction(user.id, async (client) => {
    const existing = firstRow((await client.query(`select * from public.properties where id=$1`, [id])).rows, 'Property not found');
    const role = await requireVisibleProperty(client, existing.organization_id, user.id);
    if (role === 'supervisor') {
      const project = firstRow(
        (await client.query<{ manager_user_id: string | null }>(`select manager_user_id from public.projects where id=$1`, [existing.project_id])).rows,
        'Project not found',
      );
      if (existing.assigned_manager_id !== user.id && project.manager_user_id !== user.id) {
        throw httpError(403, 'You do not have permission for this operation');
      }
    }
    const allowed = allowedPropertyPatchKeys(role);
    if (allowed.size === 0) throw httpError(403, 'You do not have permission for this operation');
    const requested = Object.keys(body).filter((key) => body[key as keyof typeof body] !== undefined);
    if (requested.some((key) => !allowed.has(key))) {
      throw httpError(403, 'You do not have permission to update one or more property fields');
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const key of requested) {
      const column = propertyPatchColumns[key];
      if (!column) continue;
      const value = body[key as keyof typeof body];
      values.push(key === 'metadata' ? JSON.stringify(value) : value);
      sets.push(`${column}=$${values.length}${key === 'metadata' ? '::jsonb' : ''}`);
    }
    if (!sets.length) return existing;
    values.push(id);
    const result = await client.query(`update public.properties set ${sets.join(', ')} where id=$${values.length} returning *`, values);
    return firstRow(result.rows, 'Property update failed');
  });
  response.json({ data: property });
});

operationsRouter.get('/properties/:id/owners', async (request, response) => {
  const user = requireUser(request);
  const { id } = idParamsSchema.parse(request.params);
  const owners = await withActorTransaction(user.id, async (client) => {
    const property = firstRow(
      (await client.query<{ organization_id: string }>(`select organization_id from public.properties where id=$1`, [id])).rows,
      'Property not found',
    );
    if (!(await currentRole(client, property.organization_id, user.id))) {
      throw httpError(404, 'Property not found');
    }
    return listPropertyOwners(client, id);
  });
  response.json({ data: owners });
});

operationsRouter.post('/properties/:id/owners', async (request, response) => {
  const user = requireUser(request);
  const { id } = idParamsSchema.parse(request.params);
  const body = linkOwnerSchema.parse(request.body);
  const link = await withActorTransaction(user.id, async (client) => {
    const property = firstRow(
      (await client.query<{ organization_id: string }>(`select organization_id from public.properties where id=$1`, [id])).rows,
      'Property not found',
    );
    const role = await requireVisibleProperty(client, property.organization_id, user.id);
    if (!OWNER_MANAGER_ROLES.includes(role)) {
      throw httpError(403, 'You do not have permission for this operation');
    }
    const owner = firstRow(
      (await client.query<{ organization_id: string }>(`select organization_id from public.owners where id=$1`, [body.ownerId])).rows,
      'Owner not found',
    );
    if (owner.organization_id !== property.organization_id) {
      throw httpError(422, 'Owner must belong to the same organization as the property');
    }
    if (body.isPrimary) {
      await client.query(`update public.property_owners set is_primary = false where property_id = $1 and is_primary = true`, [id]);
    }
    const result = await client.query(
      `insert into public.property_owners (property_id, owner_id, ownership_percent, is_primary)
       values ($1,$2,$3,$4)
       returning property_id, owner_id, ownership_percent, is_primary, created_at`,
      [id, body.ownerId, body.ownershipPercent ?? null, body.isPrimary ?? false],
    );
    return firstRow(result.rows, 'Owner link failed');
  });
  response.status(201).json({ data: link });
});

operationsRouter.delete('/properties/:id/owners/:ownerId', async (request, response) => {
  const user = requireUser(request);
  const { id, ownerId } = propertyOwnerParamsSchema.parse(request.params);
  await withActorTransaction(user.id, async (client) => {
    const property = firstRow(
      (await client.query<{ organization_id: string }>(`select organization_id from public.properties where id=$1`, [id])).rows,
      'Property not found',
    );
    const role = await requireVisibleProperty(client, property.organization_id, user.id);
    if (!OWNER_MANAGER_ROLES.includes(role)) {
      throw httpError(403, 'You do not have permission for this operation');
    }
    const result = await client.query(
      `delete from public.property_owners where property_id=$1 and owner_id=$2`,
      [id, ownerId],
    );
    if (result.rowCount === 0) throw httpError(404, 'Property owner link not found');
  });
  response.status(204).end();
});

const negotiationSelect = `
  select n.*, u.display_name as assigned_negotiator_name
    from public.negotiations n
    left join public.app_users u on u.id = n.assigned_negotiator_id`;

operationsRouter.get('/negotiations', async (request, response) => {
  const user = requireUser(request);
  const query = negotiationListQuerySchema.parse(request.query);
  const negotiations = await withActorTransaction(user.id, async (client) => {
    await requireMembership(client, query.organizationId, user.id);
    const values: unknown[] = [query.organizationId];
    const where = ['n.organization_id=$1'];
    if (query.propertyId) {
      values.push(query.propertyId);
      where.push(`n.property_id=$${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      where.push(`n.status=$${values.length}`);
    }
    const result = await client.query(
      `${negotiationSelect} where ${where.join(' and ')} order by n.updated_at desc`,
      values,
    );
    return result.rows;
  });
  response.json({ data: negotiations });
});

operationsRouter.post('/negotiations', async (request, response) => {
  const user = requireUser(request);
  const body = createNegotiationSchema.parse(request.body);
  const negotiation = await withActorTransaction(user.id, async (client) => {
    const role = await requireMembership(client, body.organizationId, user.id);
    const property = firstRow(
      (
        await client.query<{
          organization_id: string;
          acquisition_stage: string;
          assigned_negotiator_id: string | null;
        }>(`select organization_id, acquisition_stage, assigned_negotiator_id from public.properties where id=$1`, [
          body.propertyId,
        ])
      ).rows,
      'Property not found',
    );
    if (property.organization_id !== body.organizationId) {
      throw httpError(422, 'Negotiation property must belong to the same organization');
    }
    if (property.acquisition_stage !== 'negotiation') {
      throw httpError(422, 'Negotiation can only be opened when the property is in negotiation stage');
    }
    const assignedNegotiatorId =
      body.assignedNegotiatorId === undefined ? property.assigned_negotiator_id : body.assignedNegotiatorId;
    if (!canWriteNegotiation(role, assignedNegotiatorId, user.id)) {
      throw httpError(403, 'You do not have permission for this operation');
    }
    const result = await client.query(
      `insert into public.negotiations (
          organization_id, property_id, assigned_negotiator_id, opening_amount, target_amount, currency_code, started_at
        ) values ($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz, timezone('utc', now())))
        returning *`,
      [
        body.organizationId,
        body.propertyId,
        assignedNegotiatorId,
        body.openingAmount ?? null,
        body.targetAmount ?? null,
        body.currencyCode.toUpperCase(),
        body.startedAt ?? null,
      ],
    );
    return firstRow(result.rows, 'Negotiation creation failed');
  });
  response.status(201).json({ data: negotiation });
});

operationsRouter.get('/negotiations/:id', async (request, response) => {
  const user = requireUser(request);
  const { id } = idParamsSchema.parse(request.params);
  const negotiation = await withActorTransaction(user.id, async (client) => {
    const result = await client.query(`${negotiationSelect} where n.id=$1`, [id]);
    const row = firstRow(result.rows, 'Negotiation not found');
    if (!(await currentRole(client, row.organization_id, user.id))) {
      throw httpError(404, 'Negotiation not found');
    }
    return row;
  });
  response.json({ data: negotiation });
});

operationsRouter.patch('/negotiations/:id', async (request, response) => {
  const user = requireUser(request);
  const { id } = idParamsSchema.parse(request.params);
  const body = updateNegotiationSchema.parse(request.body);
  const negotiation = await withActorTransaction(user.id, async (client) => {
    const existing = firstRow(
      (await client.query(`select * from public.negotiations where id=$1`, [id])).rows,
      'Negotiation not found',
    );
    const role = await requireVisibleProperty(client, existing.organization_id, user.id);
    if (!canWriteNegotiation(role, existing.assigned_negotiator_id, user.id)) {
      throw httpError(403, 'You do not have permission for this operation');
    }
    const allowed = allowedNegotiationPatchKeys(role);
    const requested = Object.keys(body).filter((key) => body[key as keyof typeof body] !== undefined);
    if (requested.some((key) => !allowed.has(key))) {
      throw httpError(403, 'You do not have permission to update one or more negotiation fields');
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const key of requested) {
      const column = negotiationPatchColumns[key];
      if (!column) continue;
      const value = body[key as keyof typeof body];
      values.push(key === 'currencyCode' && typeof value === 'string' ? value.toUpperCase() : value);
      sets.push(`${column}=$${values.length}`);
    }
    if (!sets.length) return existing;
    values.push(id);
    const result = await client.query(
      `update public.negotiations set ${sets.join(', ')} where id=$${values.length} returning *`,
      values,
    );
    return firstRow(result.rows, 'Negotiation update failed');
  });
  response.json({ data: negotiation });
});

operationsRouter.get('/negotiations/:id/events', async (request, response) => {
  const user = requireUser(request);
  const { id } = idParamsSchema.parse(request.params);
  const events = await withActorTransaction(user.id, async (client) => {
    const negotiation = firstRow(
      (await client.query<{ organization_id: string }>(`select organization_id from public.negotiations where id=$1`, [id])).rows,
      'Negotiation not found',
    );
    if (!(await currentRole(client, negotiation.organization_id, user.id))) {
      throw httpError(404, 'Negotiation not found');
    }
    return (
      await client.query(
        `select e.*, u.display_name as actor_name
           from public.negotiation_events e
           join public.app_users u on u.id = e.actor_user_id
          where e.negotiation_id=$1
          order by e.occurred_at desc, e.created_at desc`,
        [id],
      )
    ).rows;
  });
  response.json({ data: events });
});

operationsRouter.post('/negotiations/:id/events', async (request, response) => {
  const user = requireUser(request);
  const { id } = idParamsSchema.parse(request.params);
  const body = createNegotiationEventSchema.parse(request.body);
  const event = await withActorTransaction(user.id, async (client) => {
    const negotiation = firstRow(
      (
        await client.query<{ organization_id: string; assigned_negotiator_id: string | null }>(
          `select organization_id, assigned_negotiator_id from public.negotiations where id=$1`,
          [id],
        )
      ).rows,
      'Negotiation not found',
    );
    const role = await requireVisibleProperty(client, negotiation.organization_id, user.id);
    if (!canWriteNegotiation(role, negotiation.assigned_negotiator_id, user.id)) {
      throw httpError(403, 'You do not have permission for this operation');
    }
    const result = await client.query(
      `insert into public.negotiation_events (
          organization_id, negotiation_id, event_type, amount, actor_user_id, contextual_note, occurred_at, metadata
        ) values ($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz, timezone('utc', now())),$8::jsonb)
        returning *`,
      [
        negotiation.organization_id,
        id,
        body.eventType,
        body.amount ?? null,
        user.id,
        body.contextualNote ?? null,
        body.occurredAt ?? null,
        JSON.stringify(body.metadata ?? {}),
      ],
    );
    return firstRow(result.rows, 'Negotiation event creation failed');
  });
  response.status(201).json({ data: event });
});

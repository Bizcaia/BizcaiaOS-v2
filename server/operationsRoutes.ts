import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
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
  createDocumentFieldsSchema,
  documentListQuerySchema,
  updateDocumentSchema,
  createTaskSchema,
  taskListQuerySchema,
  updateTaskSchema,
} from './operationsSchemas.js';
import { assertAcceptedFile, getDocumentStorage, loadDocumentUploadConfig } from './storage/documentStorage.js';

export const operationsRouter = Router();

const OWNER_MANAGER_ROLES: OrganizationRole[] = ['system_admin', 'land_acquisition_manager'];
const PROPERTY_CREATE_ROLES: OrganizationRole[] = ['system_admin', 'land_acquisition_manager'];
const NEGOTIATION_MANAGER_ROLES: OrganizationRole[] = ['system_admin', 'land_acquisition_manager'];
const DOCUMENT_WRITE_ROLES: OrganizationRole[] = ['system_admin', 'land_acquisition_manager', 'legal_documentation'];
const TASK_SELF_ASSIGN_CREATE_ROLES: OrganizationRole[] = ['legal_documentation', 'finance'];

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

const documentSelect = `
  select d.*, u.display_name as uploaded_by_name
    from public.documents d
    left join public.app_users u on u.id = d.uploaded_by_user_id`;

const documentPatchColumns: Record<string, string> = {
  category: 'category',
  status: 'status',
  title: 'title',
  negotiationId: 'negotiation_id',
};

/**
 * Parses the single "file" multipart field into memory and enforces multer's
 * own fileSize cutoff before any application code sees the buffer -- this is
 * the DoS backstop; assertAcceptedFile() below is the authoritative,
 * user-facing size/type check with our own error codes.
 */
function parseUploadedFile(request: Request, response: Response): Promise<void> {
  const config = loadDocumentUploadConfig();
  const middleware = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxSizeBytes } }).single('file');
  return new Promise((resolve, reject) => {
    middleware(request, response, (error: unknown) => {
      if (!error) {
        resolve();
        return;
      }
      if (error instanceof multer.MulterError) {
        reject(
          httpError(
            422,
            error.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the maximum allowed size' : error.message,
          ),
        );
        return;
      }
      reject(error);
    });
  });
}

function contentDispositionFilename(name: string): string {
  return name.replace(/[\r\n"]/g, '_');
}

operationsRouter.get('/config', async (request, response) => {
  requireUser(request);
  response.json({ data: { documentUpload: loadDocumentUploadConfig() } });
});

operationsRouter.get('/properties/:id/documents', async (request, response) => {
  const user = requireUser(request);
  const { id } = idParamsSchema.parse(request.params);
  const query = documentListQuerySchema.parse(request.query);
  const documents = await withActorTransaction(user.id, async (client) => {
    const property = firstRow(
      (await client.query<{ organization_id: string }>(`select organization_id from public.properties where id=$1`, [id])).rows,
      'Property not found',
    );
    if (!(await currentRole(client, property.organization_id, user.id))) {
      throw httpError(404, 'Property not found');
    }
    const values: unknown[] = [id];
    const where = ['d.property_id=$1'];
    if (query.category) {
      values.push(query.category);
      where.push(`d.category=$${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      where.push(`d.status=$${values.length}`);
    }
    if (!query.includeArchived) {
      where.push('d.archived_at is null');
    }
    const result = await client.query(
      `${documentSelect} where ${where.join(' and ')} order by d.created_at desc`,
      values,
    );
    return result.rows;
  });
  response.json({ data: documents });
});

operationsRouter.post('/properties/:id/documents', async (request, response) => {
  const user = requireUser(request);
  const { id } = idParamsSchema.parse(request.params);
  await parseUploadedFile(request, response);
  const file = request.file;
  if (!file) throw httpError(400, 'A file is required');
  const fields = createDocumentFieldsSchema.parse(request.body);
  assertAcceptedFile({ size: file.size, mimetype: file.mimetype }, loadDocumentUploadConfig());

  const document = await withActorTransaction(user.id, async (client) => {
    const property = firstRow(
      (await client.query<{ organization_id: string }>(`select organization_id from public.properties where id=$1`, [id])).rows,
      'Property not found',
    );
    const role = await requireVisibleProperty(client, property.organization_id, user.id);
    if (!DOCUMENT_WRITE_ROLES.includes(role)) {
      throw httpError(403, 'You do not have permission for this operation');
    }

    const documentId = randomUUID();
    const storage = await getDocumentStorage();
    const stored = await storage.put({
      organizationId: property.organization_id,
      propertyId: id,
      documentId,
      filename: file.originalname,
      contentType: file.mimetype,
      data: file.buffer,
    });
    try {
      const result = await client.query(
        `insert into public.documents (
            id, organization_id, property_id, negotiation_id, category, title,
            original_filename, content_type, size_bytes, storage_provider, storage_key, uploaded_by_user_id
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'local',$10,$11)
          returning *`,
        [
          documentId,
          property.organization_id,
          id,
          fields.negotiationId ?? null,
          fields.category,
          fields.title,
          file.originalname,
          file.mimetype,
          stored.size,
          stored.key,
          user.id,
        ],
      );
      return firstRow(result.rows, 'Document creation failed');
    } catch (error) {
      await storage.remove(stored.key);
      throw error;
    }
  });
  response.status(201).json({ data: { ...document, uploaded_by_name: user.displayName } });
});

operationsRouter.get('/documents/:id', async (request, response) => {
  const user = requireUser(request);
  const { id } = idParamsSchema.parse(request.params);
  const document = await withActorTransaction(user.id, async (client) => {
    const result = await client.query(`${documentSelect} where d.id=$1`, [id]);
    const row = firstRow(result.rows, 'Document not found');
    if (!(await currentRole(client, row.organization_id, user.id))) {
      throw httpError(404, 'Document not found');
    }
    return row;
  });
  response.json({ data: document });
});

operationsRouter.get('/documents/:id/content', async (request, response) => {
  const user = requireUser(request);
  const { id } = idParamsSchema.parse(request.params);
  const document = await withActorTransaction(user.id, async (client) => {
    const result = await client.query<{
      organization_id: string;
      original_filename: string;
      content_type: string;
      storage_key: string;
    }>(
      `select organization_id, original_filename, content_type, storage_key from public.documents where id=$1`,
      [id],
    );
    const row = firstRow(result.rows, 'Document not found');
    if (!(await currentRole(client, row.organization_id, user.id))) {
      throw httpError(404, 'Document not found');
    }
    return row;
  });
  const storage = await getDocumentStorage();
  const stream = await storage.getReadStream(document.storage_key);
  response.setHeader('Content-Type', document.content_type);
  response.setHeader(
    'Content-Disposition',
    `attachment; filename="${contentDispositionFilename(document.original_filename)}"`,
  );
  stream.pipe(response);
});

operationsRouter.patch('/documents/:id', async (request, response) => {
  const user = requireUser(request);
  const { id } = idParamsSchema.parse(request.params);
  const body = updateDocumentSchema.parse(request.body);
  const document = await withActorTransaction(user.id, async (client) => {
    const existing = firstRow(
      (await client.query(`select * from public.documents where id=$1`, [id])).rows,
      'Document not found',
    );
    const role = await requireVisibleProperty(client, existing.organization_id, user.id);
    if (!DOCUMENT_WRITE_ROLES.includes(role)) {
      throw httpError(403, 'You do not have permission for this operation');
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column}=$${values.length}`);
    };
    if (body.category !== undefined) add(documentPatchColumns.category, body.category);
    if (body.status !== undefined) add(documentPatchColumns.status, body.status);
    if (body.title !== undefined) add(documentPatchColumns.title, body.title);
    if (body.negotiationId !== undefined) add(documentPatchColumns.negotiationId, body.negotiationId);
    if (body.archived !== undefined) add('archived_at', body.archived ? new Date().toISOString() : null);
    if (!sets.length) return existing;
    values.push(id);
    const result = await client.query(
      `update public.documents set ${sets.join(', ')} where id=$${values.length} returning *`,
      values,
    );
    return firstRow(result.rows, 'Document update failed');
  });
  response.json({ data: document });
});

const taskSelect = `
  select t.*, u.display_name as assigned_user_name, c.display_name as created_by_name
    from public.tasks t
    left join public.app_users u on u.id = t.assigned_user_id
    left join public.app_users c on c.id = t.created_by_user_id`;

const taskPatchColumns: Record<string, string> = {
  title: 'title',
  description: 'description',
  status: 'status',
  priority: 'priority',
  assignedUserId: 'assigned_user_id',
  dueOn: 'due_on',
};

/**
 * Mirrors the inline supervisor-scope check already used in PATCH
 * /properties/:id: system_admin/land_acquisition_manager manage tasks
 * organization-wide; a supervisor only within a property/project they
 * manage. Not a reuse of can_update_property's scope, since that function
 * also grants legal_documentation/finance -- deliberately excluded here.
 */
async function isTaskManager(
  client: PoolClient,
  role: OrganizationRole,
  propertyManagerId: string | null,
  propertyProjectId: string,
  userId: string,
): Promise<boolean> {
  if (role === 'system_admin' || role === 'land_acquisition_manager') return true;
  if (role !== 'supervisor') return false;
  if (propertyManagerId === userId) return true;
  const project = firstRow(
    (
      await client.query<{ manager_user_id: string | null }>(
        `select manager_user_id from public.projects where id=$1`,
        [propertyProjectId],
      )
    ).rows,
    'Project not found',
  );
  return project.manager_user_id === userId;
}

operationsRouter.get('/properties/:id/tasks', async (request, response) => {
  const user = requireUser(request);
  const { id } = idParamsSchema.parse(request.params);
  const query = taskListQuerySchema.parse(request.query);
  const tasks = await withActorTransaction(user.id, async (client) => {
    const property = firstRow(
      (await client.query<{ organization_id: string }>(`select organization_id from public.properties where id=$1`, [id])).rows,
      'Property not found',
    );
    if (!(await currentRole(client, property.organization_id, user.id))) {
      throw httpError(404, 'Property not found');
    }
    const values: unknown[] = [id];
    const where = ['t.property_id=$1'];
    if (query.status) {
      values.push(query.status);
      where.push(`t.status=$${values.length}`);
    }
    if (query.priority) {
      values.push(query.priority);
      where.push(`t.priority=$${values.length}`);
    }
    if (!query.includeArchived) {
      where.push('t.archived_at is null');
    }
    const result = await client.query(
      `${taskSelect} where ${where.join(' and ')} order by t.created_at desc`,
      values,
    );
    return result.rows;
  });
  response.json({ data: tasks });
});

operationsRouter.post('/properties/:id/tasks', async (request, response) => {
  const user = requireUser(request);
  const { id } = idParamsSchema.parse(request.params);
  const body = createTaskSchema.parse(request.body);
  const task = await withActorTransaction(user.id, async (client) => {
    const property = firstRow(
      (
        await client.query<{
          organization_id: string;
          project_id: string;
          assigned_manager_id: string | null;
          assigned_negotiator_id: string | null;
        }>(
          `select organization_id, project_id, assigned_manager_id, assigned_negotiator_id from public.properties where id=$1`,
          [id],
        )
      ).rows,
      'Property not found',
    );
    const role = await requireVisibleProperty(client, property.organization_id, user.id);
    const manager = await isTaskManager(client, role, property.assigned_manager_id, property.project_id, user.id);
    const assignedUserId = body.assignedUserId ?? null;

    if (manager) {
      // any assignee, or none, as provided
    } else if (role === 'negotiator' && property.assigned_negotiator_id === user.id) {
      if (assignedUserId !== user.id) {
        throw httpError(403, 'Negotiators may only create tasks assigned to themselves');
      }
    } else if (TASK_SELF_ASSIGN_CREATE_ROLES.includes(role)) {
      if (assignedUserId !== user.id) {
        throw httpError(403, 'You may only create tasks assigned to yourself');
      }
    } else {
      throw httpError(403, 'You do not have permission for this operation');
    }

    const inserted = await client.query<{ id: string }>(
      `insert into public.tasks (
          organization_id, property_id, title, description, priority, assigned_user_id, due_on, created_by_user_id
        ) values ($1,$2,$3,$4,$5,$6,$7,$8)
        returning id`,
      [
        property.organization_id,
        id,
        body.title,
        body.description ?? null,
        body.priority,
        assignedUserId,
        body.dueOn ?? null,
        user.id,
      ],
    );
    const taskId = firstRow(inserted.rows, 'Task creation failed').id;
    const result = await client.query(`${taskSelect} where t.id=$1`, [taskId]);
    return firstRow(result.rows, 'Task creation failed');
  });
  response.status(201).json({ data: task });
});

operationsRouter.patch('/tasks/:id', async (request, response) => {
  const user = requireUser(request);
  const { id } = idParamsSchema.parse(request.params);
  const body = updateTaskSchema.parse(request.body);
  const task = await withActorTransaction(user.id, async (client) => {
    const existing = firstRow(
      (await client.query(`select * from public.tasks where id=$1`, [id])).rows,
      'Task not found',
    );
    const role = await requireVisibleProperty(client, existing.organization_id, user.id);
    const property = firstRow(
      (
        await client.query<{ project_id: string; assigned_manager_id: string | null }>(
          `select project_id, assigned_manager_id from public.properties where id=$1`,
          [existing.property_id],
        )
      ).rows,
      'Property not found',
    );
    const manager = await isTaskManager(client, role, property.assigned_manager_id, property.project_id, user.id);
    const isSelfAssignee = role !== 'viewer' && existing.assigned_user_id === user.id;
    if (!manager && !isSelfAssignee) {
      throw httpError(403, 'You do not have permission for this operation');
    }

    const requested = Object.keys(body).filter((key) => body[key as keyof typeof body] !== undefined);
    if (!manager && requested.includes('assignedUserId')) {
      throw httpError(403, 'Only elevated task managers may reassign a task');
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column}=$${values.length}`);
    };
    if (body.title !== undefined) add(taskPatchColumns.title, body.title);
    if (body.description !== undefined) add(taskPatchColumns.description, body.description);
    if (body.status !== undefined) add(taskPatchColumns.status, body.status);
    if (body.priority !== undefined) add(taskPatchColumns.priority, body.priority);
    if (body.assignedUserId !== undefined) add(taskPatchColumns.assignedUserId, body.assignedUserId);
    if (body.dueOn !== undefined) add(taskPatchColumns.dueOn, body.dueOn);
    if (body.archived !== undefined) add('archived_at', body.archived ? new Date().toISOString() : null);

    if (sets.length) {
      values.push(id);
      await client.query(`update public.tasks set ${sets.join(', ')} where id=$${values.length}`, values);
    }
    const result = await client.query(`${taskSelect} where t.id=$1`, [id]);
    return firstRow(result.rows, 'Task update failed');
  });
  response.json({ data: task });
});

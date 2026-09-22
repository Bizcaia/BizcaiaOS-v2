import { createHash, randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import type { PoolClient } from 'pg';
import { requireUser } from './auth.js';
import { firstRow, withActorTransaction, withTransaction } from './database.js';
import {
  acceptInvitationSchema,
  createInvitationSchema,
  onboardOrganizationSchema,
  organizationIdParamsSchema,
  organizationInvitationParamsSchema,
  organizationMemberParamsSchema,
  updateMembershipSchema,
  updateOrganizationSchema,
  type OrganizationRole,
} from './schemas.js';

export const apiRouter = Router();

type OrganizationRow = {
  id: string;
  name: string;
  slug: string;
  legal_name: string | null;
  timezone: string;
  settings: Record<string, unknown>;
  role?: OrganizationRole;
  created_at: string;
  updated_at: string;
};

type MemberRow = {
  user_id: string;
  display_name: string;
  email: string;
  role: OrganizationRole;
  is_active: boolean;
  created_at: string;
};

function parse<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  return schema.parse(value);
}

function tokenDigest(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

async function requireOrganizationRole(
  client: PoolClient,
  organizationId: string,
  userId: string,
  allowedRoles: OrganizationRole[],
) {
  const result = await client.query<{ role: OrganizationRole }>(
    `select role
       from public.organization_memberships
      where organization_id = $1
        and user_id = $2
        and is_active = true`,
    [organizationId, userId],
  );
  const role = result.rows[0]?.role;
  if (!role || !allowedRoles.includes(role)) {
    const error = new Error('You do not have permission for this organization operation') as Error & {
      status?: number;
    };
    error.status = 403;
    throw error;
  }
}

apiRouter.get('/me', async (request, response) => {
  const user = requireUser(request);
  const organizations = await withActorTransaction(user.id, async (client) => {
    const result = await client.query<OrganizationRow>(
      `select o.id, o.name, o.slug, o.legal_name, o.timezone, o.settings,
              o.created_at, o.updated_at, m.role
         from public.organizations o
         join public.organization_memberships m
           on m.organization_id = o.id
        where m.user_id = $1
          and m.is_active = true
        order by o.name`,
      [user.id],
    );
    return result.rows;
  });

  response.json({
    data: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      organizations,
    },
  });
});

apiRouter.post('/organizations/onboard', async (request, response) => {
  const user = requireUser(request);
  const body = parse(onboardOrganizationSchema, request.body);

  const result = await withTransaction(async (client) => {
    const query = await client.query<{ organization_id: string; user_id: string }>(
      `select * from public.bootstrap_organization($1, $2, $3, $4, $5, $6)`,
      [body.name, body.slug, user.subject, user.displayName, user.email, body.timezone],
    );
    return firstRow(query.rows, 'Organization onboarding failed');
  });

  response.status(201).json({
    data: {
      organizationId: result.organization_id,
      userId: result.user_id,
      role: 'system_admin',
    },
  });
});

apiRouter.get('/organizations', async (request, response) => {
  const user = requireUser(request);
  const organizations = await withActorTransaction(user.id, async (client) => {
    const result = await client.query<OrganizationRow>(
      `select o.id, o.name, o.slug, o.legal_name, o.timezone, o.settings,
              o.created_at, o.updated_at, m.role
         from public.organizations o
         join public.organization_memberships m
           on m.organization_id = o.id
        where m.user_id = $1
          and m.is_active = true
        order by o.name`,
      [user.id],
    );
    return result.rows;
  });
  response.json({ data: organizations });
});

apiRouter.get('/organizations/:organizationId', async (request, response) => {
  const user = requireUser(request);
  const { organizationId } = parse(organizationIdParamsSchema, request.params);
  const organization = await withActorTransaction(user.id, async (client) => {
    const result = await client.query<OrganizationRow>(
      `select id, name, slug, legal_name, timezone, settings, created_at, updated_at
         from public.organizations
        where id = $1`,
      [organizationId],
    );
    return firstRow(result.rows, 'Organization not found');
  });
  response.json({ data: organization });
});

apiRouter.patch('/organizations/:organizationId', async (request, response) => {
  const user = requireUser(request);
  const { organizationId } = parse(organizationIdParamsSchema, request.params);
  const body = parse(updateOrganizationSchema, request.body);

  const organization = await withActorTransaction(user.id, async (client) => {
    await requireOrganizationRole(client, organizationId, user.id, ['system_admin']);

    const sets: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown, cast = '') => {
      values.push(value);
      sets.push(`${column} = $${values.length}${cast}`);
    };

    if (body.name !== undefined) add('name', body.name);
    if (body.legalName !== undefined) add('legal_name', body.legalName);
    if (body.timezone !== undefined) add('timezone', body.timezone);
    if (body.settings !== undefined) add('settings', JSON.stringify(body.settings), '::jsonb');
    values.push(organizationId);

    const result = await client.query<OrganizationRow>(
      `update public.organizations
          set ${sets.join(', ')}
        where id = $${values.length}
      returning id, name, slug, legal_name, timezone, settings, created_at, updated_at`,
      values,
    );
    return firstRow(result.rows, 'Organization not found');
  });

  response.json({ data: organization });
});

apiRouter.get('/organizations/:organizationId/members', async (request, response) => {
  const user = requireUser(request);
  const { organizationId } = parse(organizationIdParamsSchema, request.params);
  const members = await withActorTransaction(user.id, async (client) => {
    const result = await client.query<MemberRow>(
      `select m.user_id, u.display_name, u.email, m.role, m.is_active, m.created_at
         from public.organization_memberships m
         join public.app_users u on u.id = m.user_id
        where m.organization_id = $1
        order by m.is_active desc, u.display_name`,
      [organizationId],
    );
    return result.rows;
  });
  response.json({ data: members });
});

apiRouter.patch('/organizations/:organizationId/members/:userId', async (request, response) => {
  const actor = requireUser(request);
  const { organizationId, userId } = parse(organizationMemberParamsSchema, request.params);
  const body = parse(updateMembershipSchema, request.body);

  const member = await withActorTransaction(actor.id, async (client) => {
    await requireOrganizationRole(client, organizationId, actor.id, ['system_admin']);
    const result = await client.query<{
      organization_id: string;
      user_id: string;
      role: OrganizationRole;
      is_active: boolean;
    }>(
      `update public.organization_memberships
          set role = coalesce($3::public.organization_role, role),
              is_active = coalesce($4::boolean, is_active)
        where organization_id = $1
          and user_id = $2
      returning organization_id, user_id, role, is_active`,
      [organizationId, userId, body.role ?? null, body.isActive ?? null],
    );
    return firstRow(result.rows, 'Organization member not found');
  });

  response.json({ data: member });
});

apiRouter.delete('/organizations/:organizationId/members/:userId', async (request, response) => {
  const actor = requireUser(request);
  const { organizationId, userId } = parse(organizationMemberParamsSchema, request.params);

  await withActorTransaction(actor.id, async (client) => {
    await requireOrganizationRole(client, organizationId, actor.id, ['system_admin']);
    const result = await client.query(
      `delete from public.organization_memberships
        where organization_id = $1
          and user_id = $2`,
      [organizationId, userId],
    );
    if (result.rowCount === 0) {
      const error = new Error('Organization member not found') as Error & { status?: number };
      error.status = 404;
      throw error;
    }
  });

  response.status(204).send();
});

apiRouter.post('/organizations/:organizationId/invitations', async (request, response) => {
  const actor = requireUser(request);
  const { organizationId } = parse(organizationIdParamsSchema, request.params);
  const body = parse(createInvitationSchema, request.body);
  const rawToken = randomBytes(32).toString('base64url');
  const digest = tokenDigest(rawToken);
  const expiresAt = new Date(Date.now() + body.expiresInHours * 60 * 60 * 1000);

  const invitation = await withActorTransaction(actor.id, async (client) => {
    await requireOrganizationRole(client, organizationId, actor.id, ['system_admin']);
    const result = await client.query<{
      id: string;
      organization_id: string;
      email: string;
      role: OrganizationRole;
      status: string;
      expires_at: string;
      created_at: string;
    }>(
      `insert into public.organization_invitations (
         organization_id, email, role, token_digest, invited_by_user_id, expires_at
       ) values ($1, $2, $3, $4, $5, $6)
       returning id, organization_id, email, role, status, expires_at, created_at`,
      [organizationId, body.email, body.role, digest, actor.id, expiresAt],
    );
    return firstRow(result.rows, 'Invitation creation failed');
  });

  response.status(201).json({
    data: invitation,
    invitationToken: rawToken,
    deliveryRequired: true,
  });
});

apiRouter.get('/organizations/:organizationId/invitations', async (request, response) => {
  const actor = requireUser(request);
  const { organizationId } = parse(organizationIdParamsSchema, request.params);
  const invitations = await withActorTransaction(actor.id, async (client) => {
    await requireOrganizationRole(client, organizationId, actor.id, ['system_admin']);
    const result = await client.query(
      `select id, organization_id, email, role, status, expires_at,
              accepted_by_user_id, accepted_at, revoked_at, created_at
         from public.organization_invitations
        where organization_id = $1
        order by created_at desc`,
      [organizationId],
    );
    return result.rows;
  });
  response.json({ data: invitations });
});

apiRouter.post(
  '/organizations/:organizationId/invitations/:invitationId/revoke',
  async (request, response) => {
    const actor = requireUser(request);
    const { organizationId, invitationId } = parse(
      organizationInvitationParamsSchema,
      request.params,
    );

    const invitation = await withActorTransaction(actor.id, async (client) => {
      await requireOrganizationRole(client, organizationId, actor.id, ['system_admin']);
      const result = await client.query(
        `update public.organization_invitations
            set status = 'revoked', revoked_at = timezone('utc', now())
          where id = $1
            and organization_id = $2
            and status = 'pending'
        returning id, organization_id, email, role, status, revoked_at`,
        [invitationId, organizationId],
      );
      return firstRow(result.rows, 'Pending invitation not found');
    });

    response.json({ data: invitation });
  },
);

apiRouter.post('/invitations/accept', async (request, response) => {
  const actor = requireUser(request);
  const body = parse(acceptInvitationSchema, request.body);
  const digest = tokenDigest(body.token);

  const membership = await withActorTransaction(actor.id, async (client) => {
    const result = await client.query<{
      organization_id: string;
      membership_role: OrganizationRole;
    }>(
      `select * from public.accept_organization_invitation($1, $2)`,
      [digest, actor.id],
    );
    return firstRow(result.rows, 'Invitation acceptance failed');
  });

  response.json({
    data: {
      organizationId: membership.organization_id,
      role: membership.membership_role,
    },
  });
});

export function requestPath(request: Request) {
  return request.originalUrl || request.url;
}

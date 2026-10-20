import type { PoolClient } from 'pg';
import type { OrganizationRole } from './schemas.js';
import type { NegotiatorActivityPeriod } from '../shared/negotiatorActivityPeriod.js';

export type NegotiatorActivityRow = {
  negotiator_id: string;
  negotiator_name: string;
  unique_landowners: number;
  total_activities: number;
};

export type NegotiatorActivityLandownerRow = {
  owner_id: string;
  display_name: string;
  interaction_count: number;
};

export type NegotiatorActivityPeriodBoundsRow = {
  timezone: string;
  period_start: Date;
  period_end: Date;
};

/**
 * Resolve organization-local [start, end) bounds for a KPI period.
 * Uses PostgreSQL date_trunc; week = ISO (Monday start).
 * Unrecognized timezone (22023) falls back to UTC, matching attentionToday.
 */
export async function resolveNegotiatorActivityPeriodBounds(
  client: PoolClient,
  organizationId: string,
  period: NegotiatorActivityPeriod,
  at?: Date,
): Promise<NegotiatorActivityPeriodBoundsRow> {
  const read = (zone: string | null) =>
    client.query<NegotiatorActivityPeriodBoundsRow>(
      `select coalesce($3::text, o.timezone) as timezone,
              case $2::text
                when 'today' then (date_trunc('day', coalesce($4::timestamptz, now()) at time zone coalesce($3::text, o.timezone)) at time zone coalesce($3::text, o.timezone))
                when 'this_week' then (date_trunc('week', coalesce($4::timestamptz, now()) at time zone coalesce($3::text, o.timezone)) at time zone coalesce($3::text, o.timezone))
                when 'this_month' then (date_trunc('month', coalesce($4::timestamptz, now()) at time zone coalesce($3::text, o.timezone)) at time zone coalesce($3::text, o.timezone))
                when 'this_year' then (date_trunc('year', coalesce($4::timestamptz, now()) at time zone coalesce($3::text, o.timezone)) at time zone coalesce($3::text, o.timezone))
              end as period_start,
              case $2::text
                when 'today' then (date_trunc('day', coalesce($4::timestamptz, now()) at time zone coalesce($3::text, o.timezone)) at time zone coalesce($3::text, o.timezone)) + interval '1 day'
                when 'this_week' then (date_trunc('week', coalesce($4::timestamptz, now()) at time zone coalesce($3::text, o.timezone)) at time zone coalesce($3::text, o.timezone)) + interval '7 days'
                when 'this_month' then (date_trunc('month', coalesce($4::timestamptz, now()) at time zone coalesce($3::text, o.timezone)) at time zone coalesce($3::text, o.timezone)) + interval '1 month'
                when 'this_year' then (date_trunc('year', coalesce($4::timestamptz, now()) at time zone coalesce($3::text, o.timezone)) at time zone coalesce($3::text, o.timezone)) + interval '1 year'
              end as period_end
         from public.organizations o
        where o.id = $1`,
      [organizationId, period, zone, at ?? null],
    );

  await client.query('savepoint negotiator_activity_period');
  try {
    const result = await read(null);
    await client.query('release savepoint negotiator_activity_period');
    const row = result.rows[0];
    if (!row) throw Object.assign(new Error('Organization not found'), { status: 404 });
    return row;
  } catch (error) {
    if ((error as { code?: unknown }).code !== '22023') throw error;
    await client.query('rollback to savepoint negotiator_activity_period');
    const result = await read('UTC');
    const row = result.rows[0];
    if (!row) throw Object.assign(new Error('Organization not found'), { status: 404 });
    return row;
  }
}

const qualifyingPredicate = `
  i.organization_id = $1
  and i.owner_id is not null
  and i.archived_at is null
  and i.occurred_at >= $2
  and i.occurred_at < $3
`;

export async function loadNegotiatorActivitySummary(
  client: PoolClient,
  organizationId: string,
  negotiatorId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<NegotiatorActivityRow> {
  const result = await client.query<{
    negotiator_id: string;
    negotiator_name: string | null;
    unique_landowners: string;
    total_activities: string;
  }>(
    `select $4::uuid as negotiator_id,
            (select display_name from public.app_users where id = $4::uuid) as negotiator_name,
            count(distinct i.owner_id)::text as unique_landowners,
            count(*)::text as total_activities
       from public.interactions i
      where ${qualifyingPredicate}
        and i.recorded_by_user_id = $4::uuid`,
    [organizationId, periodStart, periodEnd, negotiatorId],
  );
  const row = result.rows[0];
  return {
    negotiator_id: negotiatorId,
    negotiator_name: row?.negotiator_name ?? 'Unknown',
    unique_landowners: Number(row?.unique_landowners ?? 0),
    total_activities: Number(row?.total_activities ?? 0),
  };
}

export async function loadNegotiatorActivityLeaderboard(
  client: PoolClient,
  organizationId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<NegotiatorActivityRow[]> {
  const result = await client.query<{
    negotiator_id: string;
    negotiator_name: string;
    unique_landowners: string;
    total_activities: string;
  }>(
    `select i.recorded_by_user_id as negotiator_id,
            coalesce(u.display_name, 'Unknown') as negotiator_name,
            count(distinct i.owner_id)::text as unique_landowners,
            count(*)::text as total_activities
       from public.interactions i
       left join public.app_users u on u.id = i.recorded_by_user_id
      where ${qualifyingPredicate}
      group by i.recorded_by_user_id, u.display_name
      order by count(distinct i.owner_id) desc, count(*) desc, coalesce(u.display_name, 'Unknown') asc`,
    [organizationId, periodStart, periodEnd],
  );
  return result.rows.map((row) => ({
    negotiator_id: row.negotiator_id,
    negotiator_name: row.negotiator_name,
    unique_landowners: Number(row.unique_landowners),
    total_activities: Number(row.total_activities),
  }));
}

export async function loadNegotiatorActivityLandowners(
  client: PoolClient,
  organizationId: string,
  negotiatorId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<NegotiatorActivityLandownerRow[]> {
  const result = await client.query<{
    owner_id: string;
    display_name: string;
    interaction_count: string;
  }>(
    `select i.owner_id,
            coalesce(o.display_name, 'Unknown') as display_name,
            count(*)::text as interaction_count
       from public.interactions i
       left join public.owners o on o.id = i.owner_id
      where ${qualifyingPredicate}
        and i.recorded_by_user_id = $4::uuid
      group by i.owner_id, o.display_name
      order by count(*) desc, coalesce(o.display_name, 'Unknown') asc`,
    [organizationId, periodStart, periodEnd, negotiatorId],
  );
  return result.rows.map((row) => ({
    owner_id: row.owner_id,
    display_name: row.display_name,
    interaction_count: Number(row.interaction_count),
  }));
}

export function canViewNegotiatorActivityLeaderboard(role: OrganizationRole): boolean {
  return role === 'system_admin' || role === 'land_acquisition_manager' || role === 'supervisor';
}

export function resolveNegotiatorActivityTarget(params: {
  role: OrganizationRole;
  actorUserId: string;
  requestedNegotiatorId?: string | null;
}): string {
  if (params.role === 'negotiator') {
    if (params.requestedNegotiatorId && params.requestedNegotiatorId !== params.actorUserId) {
      const error = new Error('You do not have permission for this operation') as Error & { status?: number };
      error.status = 403;
      throw error;
    }
    return params.actorUserId;
  }
  return params.requestedNegotiatorId ?? params.actorUserId;
}

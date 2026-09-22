-- BizcaiaOS negotiations RLS, tenant invariants, and current-amount sync
-- Apply after 005_projects_write_rls.sql.
-- Does not alter property field-level permissions from 002_rbac_rls.sql.
--
-- v1 status rule: any existing negotiation_status value may be stored.
-- The unique index negotiations_one_open_per_property remains the only
-- extra constraint (at most one open or paused negotiation per property).
-- No additional transition graph is defined in product documentation.

create or replace function public.can_read_negotiation(
  target_property uuid,
  negotiation_negotiator uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  property_org uuid;
  property_project uuid;
  property_negotiator uuid;
  property_manager uuid;
  actor uuid := public.current_app_user_id();
  actor_role public.organization_role;
begin
  select p.organization_id, p.project_id, p.assigned_negotiator_id, p.assigned_manager_id
    into property_org, property_project, property_negotiator, property_manager
    from public.properties p
   where p.id = target_property;

  if property_org is null then
    return false;
  end if;

  if public.can_read_property(property_org, property_project, property_negotiator, property_manager) then
    return true;
  end if;

  actor_role := public.current_org_role(property_org);
  return actor_role = 'negotiator' and negotiation_negotiator = actor;
end;
$$;

create or replace function public.can_write_negotiation(
  target_org uuid,
  negotiation_negotiator uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  actor uuid := public.current_app_user_id();
  actor_role public.organization_role := public.current_org_role(target_org);
begin
  if actor is null or actor_role is null then
    return false;
  end if;

  if actor_role in ('system_admin', 'land_acquisition_manager') then
    return true;
  end if;

  return actor_role = 'negotiator' and negotiation_negotiator = actor;
end;
$$;

create or replace function public.enforce_negotiation_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  property_org uuid;
  property_stage public.acquisition_stage;
begin
  select p.organization_id, p.acquisition_stage
    into property_org, property_stage
    from public.properties p
   where p.id = new.property_id;

  if property_org is null then
    raise exception 'Property not found for negotiation'
      using errcode = 'P0002';
  end if;

  if property_org is distinct from new.organization_id then
    raise exception 'Negotiation must belong to the same organization as the property'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' and new.current_amount is not null then
    raise exception 'current_amount is derived from offer and counteroffer events'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' or (new.status in ('open', 'paused') and (tg_op = 'INSERT' or old.status is distinct from new.status)) then
    if property_stage is distinct from 'negotiation' then
      raise exception 'Negotiation can only be opened when the property is in negotiation stage'
        using errcode = '23514';
    end if;
  end if;

  if new.assigned_negotiator_id is not null and not exists (
    select 1
    from public.organization_memberships m
    where m.organization_id = new.organization_id
      and m.user_id = new.assigned_negotiator_id
      and m.is_active = true
      and m.role = 'negotiator'
  ) then
    raise exception 'Assigned negotiator must be an active negotiator in the property organization'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    if new.organization_id is distinct from old.organization_id or new.property_id is distinct from old.property_id then
      raise exception 'Negotiation organization and property cannot be changed'
        using errcode = '42501';
    end if;

    if new.current_amount is distinct from old.current_amount
       and current_setting('app.sync_current_amount', true) is distinct from 'true' then
      raise exception 'current_amount is derived from offer and counteroffer events'
        using errcode = '42501';
    end if;

    if public.current_org_role(new.organization_id) = 'negotiator'
       and new.assigned_negotiator_id is distinct from old.assigned_negotiator_id then
      raise exception 'Negotiators cannot reassign a negotiation'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.enforce_negotiation_event_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  negotiation_org uuid;
begin
  select n.organization_id into negotiation_org
    from public.negotiations n
   where n.id = new.negotiation_id;

  if negotiation_org is null then
    raise exception 'Negotiation not found for event'
      using errcode = 'P0002';
  end if;

  if negotiation_org is distinct from new.organization_id then
    raise exception 'Negotiation event must belong to the same organization as the negotiation'
      using errcode = '23514';
  end if;

  if new.actor_user_id is distinct from public.current_app_user_id() then
    raise exception 'Negotiation event actor must be the authenticated user'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create or replace function public.sync_negotiation_current_amount()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  latest_amount numeric(14, 2);
begin
  if new.event_type in ('offer', 'counteroffer') then
    -- current_amount follows the chronologically latest offer/counteroffer
    -- by occurred_at (then created_at, then id). Backdated inserts cannot
    -- overwrite a newer effective amount. Non-offer events do not enter here.
    select e.amount
      into latest_amount
      from public.negotiation_events e
     where e.negotiation_id = new.negotiation_id
       and e.event_type in ('offer', 'counteroffer')
     order by e.occurred_at desc, e.created_at desc, e.id desc
     limit 1;

    perform set_config('app.sync_current_amount', 'true', true);
    update public.negotiations
       set current_amount = latest_amount
     where id = new.negotiation_id;
    perform set_config('app.sync_current_amount', '', true);
  end if;
  return new;
end;
$$;

drop trigger if exists negotiations_scope_guard on public.negotiations;
create trigger negotiations_scope_guard
before insert or update on public.negotiations
for each row execute function public.enforce_negotiation_scope();

drop trigger if exists negotiation_events_scope_guard on public.negotiation_events;
create trigger negotiation_events_scope_guard
before insert on public.negotiation_events
for each row execute function public.enforce_negotiation_event_scope();

drop trigger if exists negotiation_events_sync_amount on public.negotiation_events;
create trigger negotiation_events_sync_amount
after insert on public.negotiation_events
for each row execute function public.sync_negotiation_current_amount();

alter table public.negotiations enable row level security;
alter table public.negotiation_events enable row level security;

drop policy if exists organization_member_read on public.negotiations;
drop policy if exists organization_member_read on public.negotiation_events;
drop policy if exists negotiations_select_visible on public.negotiations;
drop policy if exists negotiations_insert_authorized on public.negotiations;
drop policy if exists negotiations_update_authorized on public.negotiations;
drop policy if exists negotiation_events_select_visible on public.negotiation_events;
drop policy if exists negotiation_events_insert_authorized on public.negotiation_events;
drop policy if exists negotiation_events_update_attempt on public.negotiation_events;
drop policy if exists negotiation_events_delete_attempt on public.negotiation_events;
drop policy if exists negotiation_events_update_denied on public.negotiation_events;
drop policy if exists negotiation_events_delete_denied on public.negotiation_events;

create policy negotiations_select_visible
on public.negotiations
for select
using (public.can_read_negotiation(property_id, assigned_negotiator_id));

create policy negotiations_insert_authorized
on public.negotiations
for insert
with check (public.can_write_negotiation(organization_id, assigned_negotiator_id));

create policy negotiations_update_authorized
on public.negotiations
for update
using (public.can_write_negotiation(organization_id, assigned_negotiator_id))
with check (public.can_write_negotiation(organization_id, assigned_negotiator_id));

create policy negotiation_events_select_visible
on public.negotiation_events
for select
using (
  exists (
    select 1
    from public.negotiations n
    where n.id = negotiation_id
      and public.can_read_negotiation(n.property_id, n.assigned_negotiator_id)
  )
);

create policy negotiation_events_insert_authorized
on public.negotiation_events
for insert
with check (
  exists (
    select 1
    from public.negotiations n
    where n.id = negotiation_id
      and n.organization_id = negotiation_events.organization_id
      and public.can_write_negotiation(n.organization_id, n.assigned_negotiator_id)
  )
);

-- Allow authorized writers to attempt UPDATE/DELETE so the append-only
-- trigger remains the authoritative denial. Unauthorized actors still see
-- zero rows (no USING match).
create policy negotiation_events_update_attempt
on public.negotiation_events
for update
using (
  exists (
    select 1
    from public.negotiations n
    where n.id = negotiation_id
      and public.can_write_negotiation(n.organization_id, n.assigned_negotiator_id)
  )
);

create policy negotiation_events_delete_attempt
on public.negotiation_events
for delete
using (
  exists (
    select 1
    from public.negotiations n
    where n.id = negotiation_id
      and public.can_write_negotiation(n.organization_id, n.assigned_negotiator_id)
  )
);

comment on function public.can_read_negotiation(uuid, uuid) is
  'Negotiation visibility follows property visibility, plus a negotiator assigned on the negotiation.';
comment on function public.can_write_negotiation(uuid, uuid) is
  'System Administrators and Land Acquisition Managers write organization-wide; negotiators write only when assigned.';
comment on function public.enforce_negotiation_scope() is
  'Enforces tenant match, negotiation-stage opening, negotiator assignment, and derived current_amount.';
comment on function public.enforce_negotiation_event_scope() is
  'Enforces event tenant match and authenticated actor authorship.';
comment on function public.sync_negotiation_current_amount() is
  'Sets negotiations.current_amount from the latest offer/counteroffer by occurred_at; backdated inserts do not overwrite.';

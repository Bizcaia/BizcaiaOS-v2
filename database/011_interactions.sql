-- BizcaiaOS interactions: a record of an actual contact or activity
-- involving a property and, optionally, one of its owners.
-- Apply after 010_agreement_signatures.sql.
--
-- An interaction is general stakeholder contact (a call, meeting, site visit,
-- message). It is not a negotiation event: negotiation-specific activity
-- stays in negotiation_events. The distinction is meaning, not timing, so
-- an interaction may be recorded at any acquisition stage.
--
-- Access: system_admin, land_acquisition_manager, supervisor, and negotiator
-- record, read, and archive interactions within property visibility
-- (supervisors in their managed scope, negotiators on assigned properties).
-- legal_documentation, finance, and viewer have no access.
--
-- An interaction is immutable once recorded; archiving is the only change,
-- and an archived interaction cannot be restored. There is no delete.
-- The owner, when given, must be linked to the property when the
-- interaction is recorded; a later unlink does not invalidate it.
--
-- Recording an interaction never changes acquisition_stage,
-- acquisition_status, legal_status, documentation_status, payment_status,
-- Tasks, Negotiations, Payments, Documents, or Agreement Signatures.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'interaction_type') then
    create type public.interaction_type as enum (
      'call',
      'meeting',
      'site_visit',
      'message',
      'other'
    );
  end if;
end
$$;

create table if not exists public.interactions (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  property_id         uuid not null references public.properties(id) on delete restrict,
  owner_id            uuid references public.owners(id) on delete restrict,
  interaction_type    public.interaction_type not null,
  -- Must contain at least one non-whitespace character (tabs and newlines
  -- count as whitespace, unlike btrim's default).
  notes               text not null constraint interactions_notes_not_blank check (notes ~ '[^[:space:]]'),
  occurred_at         timestamptz not null default timezone('utc', now()),
  recorded_by_user_id uuid not null references public.app_users(id) on delete restrict,
  created_at          timestamptz not null default timezone('utc', now()),
  updated_at          timestamptz not null default timezone('utc', now()),
  archived_at         timestamptz
);

create index if not exists interactions_org_property_idx
  on public.interactions (organization_id, property_id);

create index if not exists interactions_owner_idx
  on public.interactions (owner_id)
  where owner_id is not null;

drop trigger if exists interactions_set_updated_at on public.interactions;
create trigger interactions_set_updated_at before update on public.interactions
  for each row execute function public.set_updated_at();

-- Property visibility AND one of the four interaction roles. Read, record,
-- and archive share this boundary.
create or replace function public.can_read_interaction(target_property uuid)
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
begin
  select p.organization_id, p.project_id, p.assigned_negotiator_id, p.assigned_manager_id
    into property_org, property_project, property_negotiator, property_manager
    from public.properties p
   where p.id = target_property;

  if property_org is null then
    return false;
  end if;

  return public.current_org_role(property_org) in (
      'system_admin'::public.organization_role,
      'land_acquisition_manager'::public.organization_role,
      'supervisor'::public.organization_role,
      'negotiator'::public.organization_role
    )
    and public.can_read_property(property_org, property_project, property_negotiator, property_manager);
end;
$$;

-- Same boundary as reading; kept as its own function so recording and
-- archiving can evolve independently of reading.
create or replace function public.can_write_interaction(target_property uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.can_read_interaction(target_property);
$$;

create or replace function public.enforce_interaction_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  property_org uuid;
begin
  if tg_op = 'UPDATE' then
    -- Only archived_at may change (updated_at is maintained by its own
    -- trigger).
    if row(new.id, new.organization_id, new.property_id, new.owner_id, new.interaction_type,
           new.notes, new.occurred_at, new.recorded_by_user_id, new.created_at)
       is distinct from
       row(old.id, old.organization_id, old.property_id, old.owner_id, old.interaction_type,
           old.notes, old.occurred_at, old.recorded_by_user_id, old.created_at) then
      raise exception 'Interactions are immutable; only archiving is allowed'
        using errcode = '42501';
    end if;
    -- There is no unarchive path: once archived, archived_at never changes.
    if old.archived_at is not null and new.archived_at is distinct from old.archived_at then
      raise exception 'An archived interaction cannot be restored or re-archived'
        using errcode = '42501';
    end if;
    return new;
  end if;

  select p.organization_id into property_org
    from public.properties p
   where p.id = new.property_id;

  if property_org is null then
    raise exception 'Property not found for interaction'
      using errcode = 'P0002';
  end if;

  if property_org is distinct from new.organization_id then
    raise exception 'Interaction must belong to the same organization as the property'
      using errcode = '23514';
  end if;

  if new.recorded_by_user_id is distinct from public.current_app_user_id() then
    raise exception 'Interaction recorder must be the authenticated user'
      using errcode = '42501';
  end if;

  -- Checked only when recording; a later unlink does not invalidate it.
  if new.owner_id is not null and not exists (
    select 1
    from public.property_owners po
    where po.property_id = new.property_id
      and po.owner_id = new.owner_id
  ) then
    raise exception 'Interaction owner must be an existing owner of the property'
      using errcode = '23514';
  end if;

  -- Zero tolerance against the server clock at the moment of recording.
  if new.occurred_at > clock_timestamp() then
    raise exception 'Interactions must record something that already happened; occurred_at is in the future'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists interactions_scope_guard on public.interactions;
create trigger interactions_scope_guard
before insert or update on public.interactions
for each row execute function public.enforce_interaction_scope();

alter table public.interactions enable row level security;

drop policy if exists interactions_select_authorized on public.interactions;
drop policy if exists interactions_insert_authorized on public.interactions;
drop policy if exists interactions_update_authorized on public.interactions;

create policy interactions_select_authorized
on public.interactions
for select
using (public.can_read_interaction(property_id));

create policy interactions_insert_authorized
on public.interactions
for insert
with check (public.can_write_interaction(property_id));

create policy interactions_update_authorized
on public.interactions
for update
using (public.can_write_interaction(property_id))
with check (public.can_write_interaction(property_id));

comment on table public.interactions is
  'An actual contact or activity involving a property and optionally one of its owners. Not a negotiation event. Immutable except archiving.';
comment on function public.can_read_interaction(uuid) is
  'Property visibility AND role in system_admin, land_acquisition_manager, supervisor, negotiator. legal_documentation, finance, and viewer have no access.';
comment on function public.can_write_interaction(uuid) is
  'Recording and archiving share the read boundary.';
comment on function public.enforce_interaction_scope() is
  'On insert: tenant match, authenticated recorder, owner linked to the property at recording time, occurred_at not in the future (zero tolerance). On update: every column except archived_at/updated_at is immutable, and archived_at never changes once set.';

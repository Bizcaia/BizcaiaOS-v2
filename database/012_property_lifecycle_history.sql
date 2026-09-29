-- BizcaiaOS property lifecycle history: an append-only record of changes to
-- a property's acquisition_stage and acquisition_status.
-- Apply after 011_interactions.sql.
--
-- Stage (workflow position) and status (operating condition) stay separate:
-- every row records exactly one field, so a change to both in one update
-- produces two rows. Readiness is a derived assessment and is never recorded
-- here.
--
-- Rows are written only by the capture trigger on public.properties, so every
-- path that changes these columns is recorded. Each row keeps the previous
-- and new value as text (history survives any later change to the enums),
-- the acting user from current_app_user_id() (null only for controlled
-- administrative or migration operations with no application actor), the
-- time, the property and its organization, and an optional reason supplied
-- by the calling operation through the transaction-local setting
-- app.lifecycle_reason. This migration does not decide when a reason is
-- required, and it enforces no transition rules.
--
-- A property's creation records its initial stage and status (from_value is
-- null). There is no backfill: properties that already exist have no history
-- until they next change. Existing values, including the legacy stage values
-- on_hold, withdrawn, and acquisition_complete, are never rewritten here.
--
-- History is property-scoped (visible exactly where the property is) and
-- immutable: no insert, update, or delete policy for users, and a guard that
-- refuses update and delete for everyone. This is not a generic audit module.

create table if not exists public.property_lifecycle_history (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- restrict: history is evidence and is never deleted with its property.
  property_id     uuid not null references public.properties(id) on delete restrict,
  field           text not null
                  constraint property_lifecycle_history_field_check
                  check (field in ('acquisition_stage', 'acquisition_status')),
  from_value      text,
  to_value        text not null,
  reason          text,
  actor_user_id   uuid references public.app_users(id) on delete restrict,
  changed_at      timestamptz not null default timezone('utc', now()),
  constraint property_lifecycle_history_value_changes
    check (from_value is distinct from to_value)
);

create index if not exists property_lifecycle_history_property_idx
  on public.property_lifecycle_history (property_id, changed_at);

-- Visibility follows the property exactly, with no widening.
create or replace function public.can_read_property_lifecycle_history(target_property uuid)
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

  return public.can_read_property(property_org, property_project, property_negotiator, property_manager);
end;
$$;

-- Records the initial values on insert and each changed value on update.
create or replace function public.record_property_lifecycle_history()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  -- Trims all surrounding whitespace (tabs and newlines too); blank means none.
  change_reason text := nullif(
    regexp_replace(coalesce(current_setting('app.lifecycle_reason', true), ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'),
    ''
  );
  actor uuid := public.current_app_user_id();
begin
  if tg_op = 'INSERT' then
    insert into public.property_lifecycle_history
      (organization_id, property_id, field, from_value, to_value, reason, actor_user_id)
    values
      (new.organization_id, new.id, 'acquisition_stage', null, new.acquisition_stage::text, change_reason, actor),
      (new.organization_id, new.id, 'acquisition_status', null, new.acquisition_status::text, change_reason, actor);
    return new;
  end if;

  if new.acquisition_stage is distinct from old.acquisition_stage then
    insert into public.property_lifecycle_history
      (organization_id, property_id, field, from_value, to_value, reason, actor_user_id)
    values
      (new.organization_id, new.id, 'acquisition_stage', old.acquisition_stage::text, new.acquisition_stage::text, change_reason, actor);
  end if;

  if new.acquisition_status is distinct from old.acquisition_status then
    insert into public.property_lifecycle_history
      (organization_id, property_id, field, from_value, to_value, reason, actor_user_id)
    values
      (new.organization_id, new.id, 'acquisition_status', old.acquisition_status::text, new.acquisition_status::text, change_reason, actor);
  end if;

  return new;
end;
$$;

drop trigger if exists properties_lifecycle_history_insert on public.properties;
create trigger properties_lifecycle_history_insert
after insert on public.properties
for each row execute function public.record_property_lifecycle_history();

drop trigger if exists properties_lifecycle_history_update on public.properties;
create trigger properties_lifecycle_history_update
after update of acquisition_stage, acquisition_status on public.properties
for each row
when (old.acquisition_stage is distinct from new.acquisition_stage
      or old.acquisition_status is distinct from new.acquisition_status)
execute function public.record_property_lifecycle_history();

create or replace function public.prevent_property_lifecycle_history_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Property lifecycle history is append-only'
    using errcode = '42501';
end;
$$;

drop trigger if exists property_lifecycle_history_immutable on public.property_lifecycle_history;
create trigger property_lifecycle_history_immutable
before update or delete on public.property_lifecycle_history
for each row execute function public.prevent_property_lifecycle_history_mutation();

alter table public.property_lifecycle_history enable row level security;

drop policy if exists property_lifecycle_history_select_visible on public.property_lifecycle_history;

-- Select only. Rows are written by the capture trigger; no role may insert,
-- update, or delete them directly.
create policy property_lifecycle_history_select_visible
on public.property_lifecycle_history
for select
using (public.can_read_property_lifecycle_history(property_id));

comment on table public.property_lifecycle_history is
  'Append-only history of acquisition_stage and acquisition_status changes, one field per row, written by trigger. Property-scoped; not a generic audit log.';
comment on function public.can_read_property_lifecycle_history(uuid) is
  'Lifecycle history visibility follows property visibility exactly; no widening.';
comment on function public.record_property_lifecycle_history() is
  'Records initial stage/status on insert and each changed stage/status on update, with actor (current_app_user_id) and optional reason (app.lifecycle_reason). Enforces no transition rules.';

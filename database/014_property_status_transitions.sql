-- BizcaiaOS status transition enforcement (L-03).
-- Apply after 013_property_stage_transitions.sql.
--
-- public.transition_property_status() becomes the only way the application
-- changes a property's acquisition_status. It applies the locked N-2 matrix:
--
--   from       to          authority                 reason  override (designated rule)
--   active     on_hold     negotiator/sup/LAM/admin  no      -
--   on_hold    active      negotiator/sup/LAM/admin  no      -
--   active     withdrawn   sup/LAM/admin             yes     -
--   on_hold    withdrawn   sup/LAM/admin             yes     -
--   active     complete    sup/LAM/admin             *       completion_stage_condition, only
--                                                            when the stage is not payment_closing
--   on_hold    complete    sup/LAM/admin             yes     on_hold_completion
--   withdrawn  active      sup/LAM/admin             yes     withdrawn_reversal
--   withdrawn  on_hold     sup/LAM/admin             yes     withdrawn_reversal
--   withdrawn  complete    sup/LAM/admin             yes     withdrawn_reversal
--   complete   active      LAM/admin                 yes     complete_reversal
--   complete   on_hold     LAM/admin                 yes     complete_reversal
--   complete   withdrawn   LAM/admin                 yes     complete_reversal
--   same       same        no-op: nothing changes and nothing is recorded
--
--   * Any move to complete away from payment_closing also overrides
--     completion_stage_condition (P-3), and every rule that applies is
--     recorded. An override always needs a reason.
--
-- The specific operation row governs: the complete reversal stays LAM and
-- system admin only, and no general override widens it. An override is
-- explicit (override = true), is refused where no designated rule applies,
-- and is recorded in lifecycle history with the rules it bypassed. That
-- history row is the override evidence (C-1); there is no attachment.
--
-- Authority is scoped by property visibility, as in 013. Only
-- acquisition_status changes; the stage is only read, for the completion
-- condition. Legacy stage values are never converted. A direct UPDATE of
-- acquisition_status by the application role is refused. Not handled here:
-- the negotiation exception, creation rules, legacy remediation,
-- stale-screen protection, and status UI.

-- History: override flag and the designated rules an override bypassed.
-- Existing rows become ordinary (non-override) rows; nothing is rewritten.
alter table public.property_lifecycle_history
  add column if not exists is_override boolean not null default false;

alter table public.property_lifecycle_history
  add column if not exists overridden_rules text[];

-- Added only when absent: a later migration (015) replaces this check with
-- the extended designated-rule list, and re-applying this file afterwards must
-- not put back the shorter list over rows that use a later rule.
do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.property_lifecycle_history'::regclass
       and c.conname = 'property_lifecycle_history_override_rules'
  ) then
    alter table public.property_lifecycle_history
      add constraint property_lifecycle_history_override_rules
      check (
        (not is_override and overridden_rules is null)
        or (
          is_override
          and cardinality(overridden_rules) > 0
          and overridden_rules <@ array[
            'completion_stage_condition',
            'on_hold_completion',
            'withdrawn_reversal',
            'complete_reversal'
          ]::text[]
        )
      );
  end if;
end;
$$;

-- Capture trigger (012), extended: a status change made by
-- transition_property_status() carries the override rules it set in the
-- transaction-local app.lifecycle_override_rules. Creation rows and stage
-- rows never carry override information.
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
  status_rules text[] := string_to_array(nullif(current_setting('app.lifecycle_override_rules', true), ''), ',');
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
      (organization_id, property_id, field, from_value, to_value, reason, actor_user_id, is_override, overridden_rules)
    values
      (new.organization_id, new.id, 'acquisition_status', old.acquisition_status::text, new.acquisition_status::text, change_reason, actor,
       status_rules is not null, status_rules);
  end if;

  return new;
end;
$$;

-- Refuses a status change made outside an owner context, so a plain UPDATE by
-- the application cannot bypass the transition rules.
create or replace function public.enforce_property_status_transition()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.acquisition_status is distinct from old.acquisition_status
     and not public.is_property_owner_context() then
    raise exception 'The acquisition status can only be changed through a status transition'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists properties_status_transition_guard on public.properties;
create trigger properties_status_transition_guard
before update of acquisition_status on public.properties
for each row execute function public.enforce_property_status_transition();

-- The field-permission guard (002) stays in force for every other update. It
-- is skipped only for a transition function's own update: an owner context
-- plus the property being transitioned (stage from 013, status from here).
drop trigger if exists properties_field_permission_guard on public.properties;
create trigger properties_field_permission_guard
before update on public.properties
for each row
when (
  not (
    public.is_property_owner_context()
    and (
      current_setting('app.stage_transition_property', true) = old.id::text
      or current_setting('app.status_transition_property', true) = old.id::text
    )
  )
)
execute function public.enforce_property_field_permissions();

create or replace function public.transition_property_status(
  target_property uuid,
  target_status public.acquisition_status,
  transition_reason text default null,
  apply_override boolean default false
)
returns public.properties
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor uuid := public.current_app_user_id();
  property_row public.properties;
  actor_role public.organization_role;
  from_status public.acquisition_status;
  allowed_roles public.organization_role[];
  reason_required boolean := false;
  rules text[] := array[]::text[];
  clean_reason text := nullif(
    regexp_replace(coalesce(transition_reason, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'),
    ''
  );
  previous_reason text := current_setting('app.lifecycle_reason', true);
  normal_roles constant public.organization_role[] :=
    array['negotiator', 'supervisor', 'land_acquisition_manager', 'system_admin']::public.organization_role[];
  controlled_roles constant public.organization_role[] :=
    array['supervisor', 'land_acquisition_manager', 'system_admin']::public.organization_role[];
  reversal_roles constant public.organization_role[] :=
    array['land_acquisition_manager', 'system_admin']::public.organization_role[];
begin
  select * into property_row from public.properties p where p.id = target_property;

  if not found
     or actor is null
     or not public.can_read_property(
       property_row.organization_id,
       property_row.project_id,
       property_row.assigned_negotiator_id,
       property_row.assigned_manager_id
     ) then
    raise exception 'Property not found'
      using errcode = 'P0002';
  end if;

  select * into property_row from public.properties p where p.id = target_property for update;
  actor_role := public.current_org_role(property_row.organization_id);
  from_status := property_row.acquisition_status;

  if target_status = from_status then
    return property_row;
  end if;

  -- The N-2 operation row: authority, reason, and designated rules.
  if (from_status, target_status) in (('active', 'on_hold'), ('on_hold', 'active')) then
    allowed_roles := normal_roles;
  elsif target_status = 'withdrawn' and from_status in ('active', 'on_hold') then
    allowed_roles := controlled_roles;
    reason_required := true;
  elsif from_status = 'active' and target_status = 'complete' then
    allowed_roles := controlled_roles;
  elsif from_status = 'on_hold' and target_status = 'complete' then
    allowed_roles := controlled_roles;
    rules := array_append(rules, 'on_hold_completion');
  elsif from_status = 'withdrawn' then
    allowed_roles := controlled_roles;
    rules := array_append(rules, 'withdrawn_reversal');
  elsif from_status = 'complete' then
    allowed_roles := reversal_roles;
    rules := array_append(rules, 'complete_reversal');
  else
    raise exception 'The status transition % to % is not defined', from_status, target_status
      using errcode = '22023';
  end if;

  -- P-3: completion requires the payment_closing stage unless overridden.
  if target_status = 'complete' and property_row.acquisition_stage <> 'payment_closing' then
    rules := array_append(rules, 'completion_stage_condition');
  end if;

  if actor_role is null or not (actor_role = any(allowed_roles)) then
    raise exception 'You do not have permission to change this property from % to %', from_status, target_status
      using errcode = '42501';
  end if;

  if (reason_required or cardinality(rules) > 0) and clean_reason is null then
    raise exception 'A reason is required to change this property from % to %', from_status, target_status
      using errcode = '22023';
  end if;

  if cardinality(rules) > 0 and not coalesce(apply_override, false) then
    raise exception 'Changing this property from % to % requires an override (%)', from_status, target_status, array_to_string(rules, ', ')
      using errcode = '22023';
  end if;

  if cardinality(rules) = 0 and coalesce(apply_override, false) then
    raise exception 'No override applies to changing this property from % to %', from_status, target_status
      using errcode = '22023';
  end if;

  perform set_config('app.lifecycle_reason', coalesce(clean_reason, ''), true);
  perform set_config('app.lifecycle_override_rules', array_to_string(rules, ','), true);
  perform set_config('app.status_transition_property', target_property::text, true);

  update public.properties p
     set acquisition_status = target_status
   where p.id = target_property
  returning * into property_row;

  perform set_config('app.status_transition_property', '', true);
  perform set_config('app.lifecycle_override_rules', '', true);
  perform set_config('app.lifecycle_reason', coalesce(previous_reason, ''), true);

  return property_row;
end;
$$;

comment on column public.property_lifecycle_history.is_override is
  'True when the change was a controlled override; the row is the override evidence.';
comment on column public.property_lifecycle_history.overridden_rules is
  'The designated rules the override bypassed; null for ordinary changes.';
comment on function public.enforce_property_status_transition() is
  'Refuses acquisition_status changes made outside transition_property_status() or another owner-controlled operation.';
comment on function public.transition_property_status(uuid, public.acquisition_status, text, boolean) is
  'The controlled path for changing acquisition_status: the locked N-2 matrix, with reasons, designated overrides recorded in history, and the payment_closing completion condition. Never changes the stage.';

-- BizcaiaOS stage transition enforcement (L-02).
-- Apply after 012_property_lifecycle_history.sql.
--
-- public.transition_property_stage() becomes the only way the application
-- changes a property's acquisition_stage. It applies the locked stage rules:
--
--   * Stage order is the order of the normal values in the acquisition_stage
--     enum (identified ... payment_closing). The workflow is non-linear
--     (X2-2): forward means any later stage, backward any earlier stage.
--   * Ordinary forward: negotiator, supervisor, land acquisition manager,
--     system admin. No reason is required.
--   * Sensitive forward: none. The sensitive-transition list is empty (N-3),
--     so every forward transition is ordinary.
--   * Backward: supervisor, land acquisition manager, system admin, with a
--     non-blank reason. This is elevated authority, not an override.
--   * Same stage: a no-op that changes nothing and records nothing.
--   * The legacy values on_hold, withdrawn, and acquisition_complete are never
--     a target, and a property on a legacy value is not moved here: those are
--     resolved only through remediation. Nothing is converted or rewritten.
--
-- Authority is scoped by property visibility (supervisors within their
-- managed scope, negotiators on assigned properties) and does not depend on
-- the generic property update rules. Only acquisition_stage changes; status
-- is never touched. History is written by the 012 capture trigger in the same
-- transaction, with the actor and the reason.
--
-- A direct UPDATE of acquisition_stage by the application role is refused, so
-- these rules cannot be bypassed. Not handled here (later slices): status
-- transitions, overrides, the negotiation exception, creation rules, legacy
-- remediation, and stale-screen protection.

-- Position of a normal stage in the workflow; null for a legacy value.
create or replace function public.acquisition_stage_position(stage public.acquisition_stage)
returns integer
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case stage
    when 'identified' then 1
    when 'initial_contact' then 2
    when 'owner_validation' then 3
    when 'property_validation' then 4
    when 'documentation' then 5
    when 'negotiation' then 6
    when 'commercial_review' then 7
    when 'legal_review' then 8
    when 'agreement_preparation' then 9
    when 'signing' then 10
    when 'payment_closing' then 11
    else null
  end;
$$;

-- True only for code running with the privileges of the properties table
-- owner (the transition function, or a controlled administrative operation).
-- Not security definer, so current_user is the caller's effective role: the
-- application role can never satisfy it, whatever settings it changes.
create or replace function public.is_property_owner_context()
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select pg_has_role(
    current_user,
    (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.properties'::regclass),
    'MEMBER'
  );
$$;

-- Refuses a stage change made outside an owner context, so a plain UPDATE by
-- the application cannot bypass the transition rules.
create or replace function public.enforce_property_stage_transition()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.acquisition_stage is distinct from old.acquisition_stage
     and not public.is_property_owner_context() then
    raise exception 'The acquisition stage can only be changed through a stage transition'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists properties_stage_transition_guard on public.properties;
create trigger properties_stage_transition_guard
before update of acquisition_stage on public.properties
for each row execute function public.enforce_property_stage_transition();

-- The field-permission guard (002) stays in force for every other update. It
-- is skipped only for the transition function's own stage update, which is
-- identified by an owner context plus the property being transitioned.
drop trigger if exists properties_field_permission_guard on public.properties;
create trigger properties_field_permission_guard
before update on public.properties
for each row
when (
  not (
    public.is_property_owner_context()
    and current_setting('app.stage_transition_property', true) = old.id::text
  )
)
execute function public.enforce_property_field_permissions();

create or replace function public.transition_property_stage(
  target_property uuid,
  target_stage public.acquisition_stage,
  transition_reason text default null
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
  from_position integer;
  to_position integer;
  clean_reason text := nullif(
    regexp_replace(coalesce(transition_reason, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'),
    ''
  );
  previous_reason text := current_setting('app.lifecycle_reason', true);
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

  if target_stage = property_row.acquisition_stage then
    return property_row;
  end if;

  from_position := public.acquisition_stage_position(property_row.acquisition_stage);
  to_position := public.acquisition_stage_position(target_stage);

  if from_position is null then
    raise exception 'The current stage % is a legacy value and can only be resolved through remediation', property_row.acquisition_stage
      using errcode = '22023';
  end if;

  if to_position is null then
    raise exception 'The stage % is a legacy value and cannot be selected', target_stage
      using errcode = '22023';
  end if;

  if to_position > from_position then
    if actor_role is null
       or actor_role not in ('negotiator', 'supervisor', 'land_acquisition_manager', 'system_admin') then
      raise exception 'You do not have permission to move this property to a later stage'
        using errcode = '42501';
    end if;
  else
    if actor_role is null
       or actor_role not in ('supervisor', 'land_acquisition_manager', 'system_admin') then
      raise exception 'You do not have permission to move this property to an earlier stage'
        using errcode = '42501';
    end if;
    if clean_reason is null then
      raise exception 'A reason is required to move a property to an earlier stage'
        using errcode = '22023';
    end if;
  end if;

  perform set_config('app.lifecycle_reason', coalesce(clean_reason, ''), true);
  perform set_config('app.stage_transition_property', target_property::text, true);

  update public.properties p
     set acquisition_stage = target_stage
   where p.id = target_property
  returning * into property_row;

  perform set_config('app.stage_transition_property', '', true);
  perform set_config('app.lifecycle_reason', coalesce(previous_reason, ''), true);

  return property_row;
end;
$$;

comment on function public.acquisition_stage_position(public.acquisition_stage) is
  'Workflow position of a normal acquisition stage (1-11, enum order); null for the legacy values on_hold, withdrawn, and acquisition_complete.';
comment on function public.is_property_owner_context() is
  'True when the current role has the properties table owner''s privileges; never true for the application role.';
comment on function public.enforce_property_stage_transition() is
  'Refuses acquisition_stage changes made outside transition_property_stage() or another owner-controlled operation.';
comment on function public.transition_property_stage(uuid, public.acquisition_stage, text) is
  'The controlled path for changing acquisition_stage: ordinary forward for the four lifecycle roles, backward for supervisor/LAM/system admin with a reason, same stage as a no-op, legacy values rejected. Records lifecycle history. Never changes status.';

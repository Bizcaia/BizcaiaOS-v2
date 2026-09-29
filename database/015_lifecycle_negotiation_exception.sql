-- BizcaiaOS lifecycle authority, overrides, and the negotiation exception (L-04).
-- Apply after 014_property_status_transitions.sql.
--
-- The negotiation exception (X2-9, S-19, P-8, N-1): a property may not leave
-- the negotiation stage while it has an unresolved negotiation, meaning one in
-- status open or paused, the negotiation module's own definition, the same
-- as its negotiations_one_open_per_property index, archived or not. The
-- designated rule negotiation_unresolved_exit may be overridden deliberately:
--
--   authority  supervisor (managed scope), LAM, system admin; never negotiator
--   reason     required (non-blank, trimmed)
--   override   required (override = true); refused where no rule applies
--   record     lifecycle history row with is_override and the rule, which
--              is the override evidence (C-1); no attachment
--
-- The exception applies to every move out of negotiation, forward or
-- backward, on top of the ordinary L-02 rules: base authority, the backward
-- reason, visibility, and legacy handling are unchanged. The negotiation
-- itself is only read, never changed. Unresolved negotiations are read
-- with the function's privileges so the block cannot depend on what the
-- caller is allowed to see.
--
-- transition_property_stage() gains an override argument; the three-argument
-- version from 013 is replaced. The designated-rule list in lifecycle history
-- gains negotiation_unresolved_exit, and stage rows can now carry override
-- information. The sensitive-transition list stays empty (N-3). Not handled
-- here: creation rules, legacy remediation, stale-screen protection, and UI.

-- Designated override rules: the four status rules (014) plus the
-- negotiation exception.
alter table public.property_lifecycle_history
  drop constraint if exists property_lifecycle_history_override_rules;

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
        'complete_reversal',
        'negotiation_unresolved_exit'
      ]::text[]
    )
  );

-- Capture trigger (012/014), extended: a stage change made by
-- transition_property_stage() carries the override rules it set in the
-- transaction-local app.lifecycle_stage_override_rules, as a status change
-- does with app.lifecycle_override_rules. Creation rows never carry them.
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
  stage_rules text[] := string_to_array(nullif(current_setting('app.lifecycle_stage_override_rules', true), ''), ',');
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
      (organization_id, property_id, field, from_value, to_value, reason, actor_user_id, is_override, overridden_rules)
    values
      (new.organization_id, new.id, 'acquisition_stage', old.acquisition_stage::text, new.acquisition_stage::text, change_reason, actor,
       stage_rules is not null, stage_rules);
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

-- The 013 signature is replaced by one with the override argument, so a
-- three-argument call has exactly one candidate.
drop function if exists public.transition_property_stage(uuid, public.acquisition_stage, text);

create or replace function public.transition_property_stage(
  target_property uuid,
  target_stage public.acquisition_stage,
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
  from_position integer;
  to_position integer;
  rules text[] := array[]::text[];
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

  -- The operation row (L-02): ordinary forward or backward.
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

  -- Prerequisite (X2-9, P-8): leaving negotiation with an unresolved negotiation.
  if property_row.acquisition_stage = 'negotiation'
     and exists (
       select 1
         from public.negotiations n
        where n.property_id = target_property
          and n.status in ('open', 'paused')
     ) then
    rules := array_append(rules, 'negotiation_unresolved_exit');
  end if;

  -- The designated exception row (N-1): its own authority, reason, and an
  -- explicit override. It never widens the operation row above.
  if cardinality(rules) > 0 then
    if actor_role not in ('supervisor', 'land_acquisition_manager', 'system_admin') then
      raise exception 'You do not have permission to leave negotiation while a negotiation is open or paused'
        using errcode = '42501';
    end if;
    if clean_reason is null then
      raise exception 'A reason is required to leave negotiation while a negotiation is open or paused'
        using errcode = '22023';
    end if;
    if not coalesce(apply_override, false) then
      raise exception 'Leaving negotiation while a negotiation is open or paused requires an override (negotiation_unresolved_exit)'
        using errcode = '22023';
    end if;
  elsif coalesce(apply_override, false) then
    raise exception 'No override applies to moving this property from % to %', property_row.acquisition_stage, target_stage
      using errcode = '22023';
  end if;

  perform set_config('app.lifecycle_reason', coalesce(clean_reason, ''), true);
  perform set_config('app.lifecycle_stage_override_rules', array_to_string(rules, ','), true);
  perform set_config('app.stage_transition_property', target_property::text, true);

  update public.properties p
     set acquisition_stage = target_stage
   where p.id = target_property
  returning * into property_row;

  perform set_config('app.stage_transition_property', '', true);
  perform set_config('app.lifecycle_stage_override_rules', '', true);
  perform set_config('app.lifecycle_reason', coalesce(previous_reason, ''), true);

  return property_row;
end;
$$;

comment on function public.transition_property_stage(uuid, public.acquisition_stage, text, boolean) is
  'The controlled path for changing acquisition_stage: ordinary forward for the four lifecycle roles, backward for supervisor/LAM/system admin with a reason, same stage as a no-op, legacy values rejected, and leaving negotiation with an open or paused negotiation only through the negotiation_unresolved_exit override (supervisor/LAM/system admin, reason). Records lifecycle history; never changes status or the negotiation.';

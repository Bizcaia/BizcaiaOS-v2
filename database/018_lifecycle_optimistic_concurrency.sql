-- BizcaiaOS lifecycle optimistic concurrency (L-07).
-- Apply after 017_legacy_stage_remediation.sql.
--
-- D-X1 field-level optimistic concurrency, for the lifecycle fields (S-26):
-- a stale screen must not silently overwrite acquisition_stage or
-- acquisition_status after another change. Each function that changes one of
-- them takes the value the caller's screen showed (the field's own value is
-- the version token, architecture section O):
--
--   transition_property_stage(...,  expected_stage)
--   transition_property_status(..., expected_status)
--   resolve_property_stage_remediation(..., expected_stage)
--
-- It is compared under the existing row lock (select ... for update), after
-- visibility and before any other rule. A mismatch changes nothing, writes no
-- history, and raises SQLSTATE 40001 with a JSON detail naming the field and
-- the current and expected values (S-25), which the API returns as a 409
-- lifecycle conflict. A null expected value means no screen state was
-- asserted (owner-controlled operations); the API always sends one.
--
-- Concurrent calls on one property are serialized by that row lock, so the
-- second caller sees the first's committed result: a stale stage or status
-- becomes a conflict, while a change to the other field proceeds (D-X1:
-- non-conflicting fields may be saved). Remediation steps other than
-- resolution change no lifecycle field; their stale attempts stay refused by
-- the cycle-state checks (017).
--
-- The function bodies are otherwise those of 015, 014, and 017. The previous
-- signatures are dropped so each call has exactly one candidate.

drop function if exists public.transition_property_stage(uuid, public.acquisition_stage, text, boolean);
drop function if exists public.transition_property_status(uuid, public.acquisition_status, text, boolean);
drop function if exists public.resolve_property_stage_remediation(uuid, public.acquisition_stage, text, text, uuid, uuid);

create or replace function public.transition_property_stage(
  target_property uuid,
  target_stage public.acquisition_stage,
  transition_reason text default null,
  apply_override boolean default false,
  expected_stage public.acquisition_stage default null
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

  -- D-X1: a stale screen must not silently overwrite a newer acquisition_stage.
  if expected_stage is not null and expected_stage <> property_row.acquisition_stage then
    raise exception 'The acquisition stage is now % (this screen showed %); reload before retrying', property_row.acquisition_stage, expected_stage
      using errcode = '40001',
            detail = json_build_object('conflict', 'lifecycle', 'field', 'acquisition_stage', 'current', property_row.acquisition_stage, 'expected', expected_stage)::text;
  end if;

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

create or replace function public.transition_property_status(
  target_property uuid,
  target_status public.acquisition_status,
  transition_reason text default null,
  apply_override boolean default false,
  expected_status public.acquisition_status default null
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

  -- D-X1: a stale screen must not silently overwrite a newer acquisition_status.
  if expected_status is not null and expected_status <> property_row.acquisition_status then
    raise exception 'The acquisition status is now % (this screen showed %); reload before retrying', property_row.acquisition_status, expected_status
      using errcode = '40001',
            detail = json_build_object('conflict', 'lifecycle', 'field', 'acquisition_status', 'current', property_row.acquisition_status, 'expected', expected_status)::text;
  end if;

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

create or replace function public.resolve_property_stage_remediation(
  target_property uuid,
  resulting_stage public.acquisition_stage,
  resolution_reason text,
  evidence text,
  evidence_document_id uuid default null,
  evidence_interaction_id uuid default null,
  expected_stage public.acquisition_stage default null
)
returns public.property_stage_remediations
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  property_row public.properties := public.authorize_property_stage_remediation(target_property);
  remediation public.property_stage_remediations;
  clean_reason text := public.trim_lifecycle_text(resolution_reason);
  clean_evidence text := public.trim_lifecycle_text(evidence);
  previous_reason text := current_setting('app.lifecycle_reason', true);
begin
  -- D-X1: a stale screen must not silently overwrite a newer acquisition_stage.
  if expected_stage is not null and expected_stage <> property_row.acquisition_stage then
    raise exception 'The acquisition stage is now % (this screen showed %); reload before retrying', property_row.acquisition_stage, expected_stage
      using errcode = '40001',
            detail = json_build_object('conflict', 'lifecycle', 'field', 'acquisition_stage', 'current', property_row.acquisition_stage, 'expected', expected_stage)::text;
  end if;

  remediation := public.open_property_stage_remediation(target_property, 'UNDER_REVIEW');

  if clean_reason is null then
    raise exception 'A reason is required to resolve a legacy stage'
      using errcode = '22023';
  end if;

  if clean_evidence is null then
    raise exception 'Supporting evidence is required to resolve a legacy stage'
      using errcode = '22023';
  end if;

  if evidence_document_id is not null and evidence_interaction_id is not null then
    raise exception 'Reference either a document or an interaction as evidence, not both'
      using errcode = '22023';
  end if;

  if evidence_document_id is not null and not exists (
    select 1 from public.documents d where d.id = evidence_document_id and d.property_id = target_property
  ) then
    raise exception 'The evidence document must belong to this property'
      using errcode = '22023';
  end if;

  if evidence_interaction_id is not null and not exists (
    select 1 from public.interactions i where i.id = evidence_interaction_id and i.property_id = target_property
  ) then
    raise exception 'The evidence interaction must belong to this property'
      using errcode = '22023';
  end if;

  -- Integrity (P-12): a normal stage, and the negotiation hard block.
  if public.acquisition_stage_position(resulting_stage) is null then
    raise exception 'The stage % is a legacy value and cannot be the corrected stage', resulting_stage
      using errcode = '22023';
  end if;

  if resulting_stage <> 'negotiation' and exists (
    select 1 from public.negotiations n where n.property_id = target_property and n.status in ('open', 'paused')
  ) then
    raise exception 'A property with an open or paused negotiation can only be resolved to negotiation'
      using errcode = '22023';
  end if;

  update public.property_stage_remediations r
     set state = 'RESOLVED',
         resolved_by_user_id = public.current_app_user_id(),
         resolved_at = timezone('utc', now()),
         resulting_stage = resolve_property_stage_remediation.resulting_stage::text,
         resolution_reason = clean_reason,
         evidence = clean_evidence,
         evidence_document_id = resolve_property_stage_remediation.evidence_document_id,
         evidence_interaction_id = resolve_property_stage_remediation.evidence_interaction_id
   where r.id = remediation.id
  returning * into remediation;

  insert into public.property_stage_remediation_events
    (organization_id, property_id, remediation_id, action, from_state, to_state, reason, actor_user_id)
  values
    (property_row.organization_id, target_property, remediation.id, 'resolved', 'UNDER_REVIEW', 'RESOLVED', clean_reason,
     public.current_app_user_id());

  if property_row.acquisition_stage <> resolve_property_stage_remediation.resulting_stage then
    perform set_config('app.lifecycle_reason', clean_reason, true);
    perform set_config('app.lifecycle_stage_override_rules', '', true);
    perform set_config('app.stage_transition_property', target_property::text, true);

    update public.properties p
       set acquisition_stage = resolve_property_stage_remediation.resulting_stage
     where p.id = target_property;

    perform set_config('app.stage_transition_property', '', true);
    perform set_config('app.lifecycle_reason', coalesce(previous_reason, ''), true);
  end if;

  return remediation;
end;
$$;

comment on function public.transition_property_stage(uuid, public.acquisition_stage, text, boolean, public.acquisition_stage) is
  'The controlled path for changing acquisition_stage (L-02/L-04), with D-X1 optimistic concurrency: a stale expected_stage raises a 40001 lifecycle conflict.';
comment on function public.transition_property_status(uuid, public.acquisition_status, text, boolean, public.acquisition_status) is
  'The controlled path for changing acquisition_status (L-03), with D-X1 optimistic concurrency: a stale expected_status raises a 40001 lifecycle conflict.';
comment on function public.resolve_property_stage_remediation(uuid, public.acquisition_stage, text, text, uuid, uuid, public.acquisition_stage) is
  'Resolves a legacy stage (L-06), with D-X1 optimistic concurrency on the stage: a stale expected_stage raises a 40001 lifecycle conflict.';

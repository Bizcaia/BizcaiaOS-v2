-- BizcaiaOS legacy stage remediation (L-06).
-- Apply after 016_property_creation_rules.sql.
--
-- A property still on a legacy stage value (on_hold, withdrawn,
-- acquisition_complete) is corrected only through this controlled workflow,
-- never by conversion, PATCH, an ordinary stage transition, or a direct UPDATE
-- (X2-3). Nothing here changes existing data.
--
-- States (R-6), per review cycle:
--
--   NOT_REVIEWED         not stored: a legacy-stage property without an open
--                        cycle (listed by query, architecture section N)
--   UNDER_REVIEW         start review, or return an escalation to review
--   REQUIRES_ESCALATION  the reviewer finds the evidence insufficient to
--                        determine the correct stage (R-8); the legacy value
--                        is kept, nothing is inferred
--   RESOLVED             terminal (R-9): the property moves to the corrected
--                        normal stage
--
--   UNDER_REVIEW -> REQUIRES_ESCALATION -> UNDER_REVIEW (escalation resolution)
--   UNDER_REVIEW -> RESOLVED
--   RESOLVED     -> reopen: a new cycle in UNDER_REVIEW; the earlier cycle and
--                   its decision are kept unchanged (R-7)
--
-- Authority (N-1, legacy remediation): supervisor within managed scope, LAM,
-- and system admin, for every operation; never negotiator, legal, finance, or
-- viewer. Property visibility applies first. The sensitive-transition list is
-- empty (N-3), so there is a single authority tier.
--
-- Every resolution needs a non-blank reason AND non-blank supporting evidence
-- (Q-1 = B, R-3), with an optional reference to one document or interaction
-- of the same property. Escalating needs a non-blank reason (Q-3 = A);
-- returning to review (Q-4 = B) and reopening (Q-5 = B) take an optional
-- reason. Reasons and evidence are trimmed; a blank optional reason is none.
--
-- A resolution passes the integrity rules (P-12): the corrected stage must be
-- a normal stage, and the negotiation hard block applies (a property with an
-- open or paused negotiation can only be resolved to negotiation). It
-- bypasses the ordinary transition matrix and authority, but never status:
-- the status is not touched (R-5).
--
-- Records (R-4): one row per cycle in property_stage_remediations (legacy
-- value, stage at opening, state, resolution, reason, evidence), an
-- append-only property_stage_remediation_events log of every step, and the
-- lifecycle history row for the stage change, linked to its cycle and shown in
-- the Timeline as a legacy remediation. All writes go through the functions
-- below; the application role cannot write these tables directly.

create table if not exists public.property_stage_remediations (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,
  property_id             uuid not null references public.properties(id) on delete restrict,
  cycle                   integer not null check (cycle > 0),
  legacy_value            text not null
                          check (legacy_value in ('on_hold', 'withdrawn', 'acquisition_complete')),
  stage_at_open           text not null,
  state                   text not null
                          check (state in ('UNDER_REVIEW', 'REQUIRES_ESCALATION', 'RESOLVED')),
  opened_by_user_id       uuid not null references public.app_users(id) on delete restrict,
  opened_at               timestamptz not null default timezone('utc', now()),
  resolved_by_user_id     uuid references public.app_users(id) on delete restrict,
  resolved_at             timestamptz,
  resulting_stage         text,
  resolution_reason       text,
  evidence                text,
  evidence_document_id    uuid references public.documents(id) on delete restrict,
  evidence_interaction_id uuid references public.interactions(id) on delete restrict,
  constraint property_stage_remediations_cycle_unique unique (property_id, cycle),
  constraint property_stage_remediations_one_reference
    check (num_nonnulls(evidence_document_id, evidence_interaction_id) <= 1),
  constraint property_stage_remediations_resolution
    check (
      (state <> 'RESOLVED'
        and resolved_by_user_id is null and resolved_at is null and resulting_stage is null
        and resolution_reason is null and evidence is null
        and evidence_document_id is null and evidence_interaction_id is null)
      or (state = 'RESOLVED'
        and resolved_by_user_id is not null and resolved_at is not null and resulting_stage is not null
        and resolution_reason ~ '[^[:space:]]' and evidence ~ '[^[:space:]]')
    )
);

-- At most one open cycle per property.
create unique index if not exists property_stage_remediations_one_open
  on public.property_stage_remediations (property_id)
  where state in ('UNDER_REVIEW', 'REQUIRES_ESCALATION');

create index if not exists property_stage_remediations_org_state_idx
  on public.property_stage_remediations (organization_id, state);

create table if not exists public.property_stage_remediation_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id     uuid not null references public.properties(id) on delete restrict,
  remediation_id  uuid not null references public.property_stage_remediations(id) on delete restrict,
  action          text not null
                  check (action in ('review_started', 'escalated', 'returned_to_review', 'resolved', 'reopened')),
  from_state      text,
  to_state        text not null,
  reason          text,
  actor_user_id   uuid not null references public.app_users(id) on delete restrict,
  occurred_at     timestamptz not null default timezone('utc', now())
);

create index if not exists property_stage_remediation_events_remediation_idx
  on public.property_stage_remediation_events (remediation_id, occurred_at);

-- Lifecycle history rows written by a resolution point to their cycle.
alter table public.property_lifecycle_history
  add column if not exists remediation_id uuid references public.property_stage_remediations(id) on delete restrict;

-- A resolved cycle is preserved as decided; cycles and events are never deleted.
create or replace function public.prevent_resolved_remediation_change()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' or old.state = 'RESOLVED' then
    raise exception 'A resolved or recorded remediation cycle cannot be changed or deleted'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists property_stage_remediations_preserved on public.property_stage_remediations;
create trigger property_stage_remediations_preserved
before update or delete on public.property_stage_remediations
for each row execute function public.prevent_resolved_remediation_change();

create or replace function public.prevent_remediation_event_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'Remediation events are append-only'
    using errcode = '42501';
end;
$$;

drop trigger if exists property_stage_remediation_events_immutable on public.property_stage_remediation_events;
create trigger property_stage_remediation_events_immutable
before update or delete on public.property_stage_remediation_events
for each row execute function public.prevent_remediation_event_mutation();

-- Visible exactly where the property is; written only through the functions.
alter table public.property_stage_remediations enable row level security;
alter table public.property_stage_remediation_events enable row level security;

drop policy if exists property_stage_remediations_select_visible on public.property_stage_remediations;
create policy property_stage_remediations_select_visible
on public.property_stage_remediations
for select
using (public.can_read_property_lifecycle_history(property_id));

drop policy if exists property_stage_remediation_events_select_visible on public.property_stage_remediation_events;
create policy property_stage_remediation_events_select_visible
on public.property_stage_remediation_events
for select
using (public.can_read_property_lifecycle_history(property_id));

-- Capture trigger (012/014/015), extended: a stage change made by a
-- resolution links to its cycle. The link is derived from the remediation
-- record itself (resolved in this transaction, for this property, from the
-- stage at opening to the resulting stage, not yet linked), not from any
-- session setting, so it cannot be spoofed.
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
  resolved_cycle uuid;
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
    select r.id into resolved_cycle
      from public.property_stage_remediations r
     where r.property_id = new.id
       and r.state = 'RESOLVED'
       and r.resolved_at = timezone('utc', now())
       and r.stage_at_open = old.acquisition_stage::text
       and r.resulting_stage = new.acquisition_stage::text
       and not exists (select 1 from public.property_lifecycle_history h where h.remediation_id = r.id);

    insert into public.property_lifecycle_history
      (organization_id, property_id, field, from_value, to_value, reason, actor_user_id, is_override, overridden_rules, remediation_id)
    values
      (new.organization_id, new.id, 'acquisition_stage', old.acquisition_stage::text, new.acquisition_stage::text, change_reason, actor,
       stage_rules is not null, stage_rules, resolved_cycle);
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

-- Shared checks: the property is visible (else P0002) and the actor holds the
-- remediation authority (else 42501). Returns the locked property row.
create or replace function public.authorize_property_stage_remediation(target_property uuid)
returns public.properties
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  property_row public.properties;
  actor_role public.organization_role;
begin
  select * into property_row from public.properties p where p.id = target_property;

  if not found
     or public.current_app_user_id() is null
     or not public.can_read_property(
       property_row.organization_id,
       property_row.project_id,
       property_row.assigned_negotiator_id,
       property_row.assigned_manager_id
     ) then
    raise exception 'Property not found'
      using errcode = 'P0002';
  end if;

  actor_role := public.current_org_role(property_row.organization_id);
  if actor_role is null or actor_role not in ('supervisor', 'land_acquisition_manager', 'system_admin') then
    raise exception 'You do not have permission to remediate this property''s legacy stage'
      using errcode = '42501';
  end if;

  select * into property_row from public.properties p where p.id = target_property for update;
  return property_row;
end;
$$;

create or replace function public.trim_lifecycle_text(value text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select nullif(regexp_replace(coalesce(value, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
$$;

-- NOT_REVIEWED -> UNDER_REVIEW: opens the first cycle for a legacy-stage property.
create or replace function public.start_property_stage_remediation(target_property uuid)
returns public.property_stage_remediations
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  property_row public.properties := public.authorize_property_stage_remediation(target_property);
  remediation public.property_stage_remediations;
begin
  if public.acquisition_stage_position(property_row.acquisition_stage) is not null then
    raise exception 'The stage % is not a legacy value; there is nothing to remediate', property_row.acquisition_stage
      using errcode = '22023';
  end if;

  if exists (select 1 from public.property_stage_remediations r where r.property_id = target_property) then
    raise exception 'This property already has a remediation cycle; continue or reopen it'
      using errcode = '22023';
  end if;

  insert into public.property_stage_remediations
    (organization_id, property_id, cycle, legacy_value, stage_at_open, state, opened_by_user_id)
  values
    (property_row.organization_id, target_property, 1, property_row.acquisition_stage::text,
     property_row.acquisition_stage::text, 'UNDER_REVIEW', public.current_app_user_id())
  returning * into remediation;

  insert into public.property_stage_remediation_events
    (organization_id, property_id, remediation_id, action, from_state, to_state, actor_user_id)
  values
    (property_row.organization_id, target_property, remediation.id, 'review_started', 'NOT_REVIEWED', 'UNDER_REVIEW',
     public.current_app_user_id());

  return remediation;
end;
$$;

-- The open cycle of a property in the expected state, locked (22023 otherwise).
create or replace function public.open_property_stage_remediation(target_property uuid, expected_state text)
returns public.property_stage_remediations
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  remediation public.property_stage_remediations;
begin
  select * into remediation
    from public.property_stage_remediations r
   where r.property_id = target_property
   order by r.cycle desc
   limit 1
   for update;

  if not found or remediation.state <> expected_state then
    raise exception 'No remediation cycle of this property is %', expected_state
      using errcode = '22023';
  end if;

  return remediation;
end;
$$;

-- Records a state change of the open cycle and its event, with the step's
-- reason if one was given (whether one is required is decided by the caller).
create or replace function public.move_property_stage_remediation(
  target_property uuid,
  from_state text,
  to_state text,
  event_action text,
  step_reason text
)
returns public.property_stage_remediations
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  property_row public.properties := public.authorize_property_stage_remediation(target_property);
  remediation public.property_stage_remediations := public.open_property_stage_remediation(target_property, from_state);
  clean_reason text := public.trim_lifecycle_text(step_reason);
begin
  update public.property_stage_remediations r set state = to_state where r.id = remediation.id
  returning * into remediation;

  insert into public.property_stage_remediation_events
    (organization_id, property_id, remediation_id, action, from_state, to_state, reason, actor_user_id)
  values
    (property_row.organization_id, target_property, remediation.id, event_action, from_state, to_state, clean_reason,
     public.current_app_user_id());

  return remediation;
end;
$$;

-- UNDER_REVIEW -> REQUIRES_ESCALATION: evidence insufficient (R-8). The stage is
-- kept. A non-blank reason is required (Q-3 = A).
create or replace function public.escalate_property_stage_remediation(target_property uuid, escalation_reason text)
returns public.property_stage_remediations
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  remediation public.property_stage_remediations;
begin
  -- Visibility, authority, and the cycle state are checked first, as for every step.
  perform public.authorize_property_stage_remediation(target_property);
  perform public.open_property_stage_remediation(target_property, 'UNDER_REVIEW');

  if public.trim_lifecycle_text(escalation_reason) is null then
    raise exception 'A reason is required to escalate this remediation'
      using errcode = '22023';
  end if;

  remediation := public.move_property_stage_remediation(
    target_property, 'UNDER_REVIEW', 'REQUIRES_ESCALATION', 'escalated', escalation_reason
  );
  return remediation;
end;
$$;

-- REQUIRES_ESCALATION -> UNDER_REVIEW: escalation resolution; the reason is
-- optional (Q-4 = B).
create or replace function public.return_property_stage_remediation_to_review(target_property uuid, return_reason text)
returns public.property_stage_remediations
language sql
security definer
set search_path = pg_catalog, public
as $$
  select * from public.move_property_stage_remediation(target_property, 'REQUIRES_ESCALATION', 'UNDER_REVIEW', 'returned_to_review', return_reason);
$$;

-- UNDER_REVIEW -> RESOLVED: the corrected stage, with reason and evidence (Q-1).
create or replace function public.resolve_property_stage_remediation(
  target_property uuid,
  resulting_stage public.acquisition_stage,
  resolution_reason text,
  evidence text,
  evidence_document_id uuid default null,
  evidence_interaction_id uuid default null
)
returns public.property_stage_remediations
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  property_row public.properties := public.authorize_property_stage_remediation(target_property);
  remediation public.property_stage_remediations := public.open_property_stage_remediation(target_property, 'UNDER_REVIEW');
  clean_reason text := public.trim_lifecycle_text(resolution_reason);
  clean_evidence text := public.trim_lifecycle_text(evidence);
  previous_reason text := current_setting('app.lifecycle_reason', true);
begin
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

-- RESOLVED -> a new cycle in UNDER_REVIEW (R-7); the resolved cycle is kept.
-- The reason is optional (Q-5 = B).
create or replace function public.reopen_property_stage_remediation(target_property uuid, reopen_reason text)
returns public.property_stage_remediations
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  property_row public.properties := public.authorize_property_stage_remediation(target_property);
  previous public.property_stage_remediations := public.open_property_stage_remediation(target_property, 'RESOLVED');
  clean_reason text := public.trim_lifecycle_text(reopen_reason);
  remediation public.property_stage_remediations;
begin
  insert into public.property_stage_remediations
    (organization_id, property_id, cycle, legacy_value, stage_at_open, state, opened_by_user_id)
  values
    (property_row.organization_id, target_property, previous.cycle + 1, previous.legacy_value,
     property_row.acquisition_stage::text, 'UNDER_REVIEW', public.current_app_user_id())
  returning * into remediation;

  insert into public.property_stage_remediation_events
    (organization_id, property_id, remediation_id, action, from_state, to_state, reason, actor_user_id)
  values
    (property_row.organization_id, target_property, remediation.id, 'reopened', 'RESOLVED', 'UNDER_REVIEW', clean_reason,
     public.current_app_user_id());

  return remediation;
end;
$$;

comment on table public.property_stage_remediations is
  'Legacy stage remediation cycles (R-4, R-6, R-7): legacy value, state, and the resolution with reason and evidence (Q-1). Written only through the remediation functions.';
comment on table public.property_stage_remediation_events is
  'Append-only log of every remediation step (review started, escalated, returned to review, resolved, reopened) with actor and reason.';
comment on column public.property_lifecycle_history.remediation_id is
  'The remediation cycle whose resolution made this stage change; null for ordinary changes.';
comment on function public.resolve_property_stage_remediation(uuid, public.acquisition_stage, text, text, uuid, uuid) is
  'Resolves a legacy stage (supervisor/LAM/system admin): reason and evidence required (Q-1), optional same-property document or interaction reference, normal target and the negotiation hard block (P-12). Never changes status.';

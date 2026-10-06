-- BizcaiaOS property risk history (Candidate D).
-- Apply after 019_revoke_public_function_execute.sql.
--
-- A change to a property's risk level (low, medium, high) is recorded in
-- public.property_lifecycle_history, like a change to its acquisition stage
-- or status: one row with the previous and new value as text, the acting user
-- from current_app_user_id(), and the time. The row is written by the capture
-- trigger on public.properties, so every path that changes risk is recorded,
-- and it inherits the table's rules: visible exactly where the property is,
-- and never updated or deleted.
--
-- Only actual changes are recorded. Creating a property records no risk row
-- (its initial stage and status rows are unchanged), an update that leaves
-- risk as it was records nothing, and there is no backfill: a property that
-- already exists has no risk history until its risk next changes. A risk row
-- has no reason and is never an override.
--
-- This migration creates no function, table, policy, or grant. It widens the
-- field check, replaces the capture function (017's version plus the risk
-- row), and makes the update trigger fire on risk as well.

alter table public.property_lifecycle_history
  drop constraint if exists property_lifecycle_history_field_check;

alter table public.property_lifecycle_history
  add constraint property_lifecycle_history_field_check
  check (field in ('acquisition_stage', 'acquisition_status', 'risk'));

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

  -- A risk change carries no reason and is never an override: a reason or rule
  -- set by a lifecycle operation in the same transaction belongs to that
  -- operation's own row.
  if new.risk is distinct from old.risk then
    insert into public.property_lifecycle_history
      (organization_id, property_id, field, from_value, to_value, actor_user_id)
    values
      (new.organization_id, new.id, 'risk', old.risk::text, new.risk::text, actor);
  end if;

  return new;
end;
$$;

drop trigger if exists properties_lifecycle_history_update on public.properties;
create trigger properties_lifecycle_history_update
after update of acquisition_stage, acquisition_status, risk on public.properties
for each row
when (old.acquisition_stage is distinct from new.acquisition_stage
      or old.acquisition_status is distinct from new.acquisition_status
      or old.risk is distinct from new.risk)
execute function public.record_property_lifecycle_history();

comment on table public.property_lifecycle_history is
  'Append-only history of acquisition_stage, acquisition_status, and risk changes, one field per row, written by trigger. Property-scoped; not a generic audit log.';
comment on function public.record_property_lifecycle_history() is
  'Records initial stage/status on insert and each changed stage/status/risk on update, with actor (current_app_user_id) and, for stage and status, an optional reason (app.lifecycle_reason). Enforces no transition rules.';

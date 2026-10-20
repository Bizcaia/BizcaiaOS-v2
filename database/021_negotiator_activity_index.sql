-- Negotiator Activity KPI: index for qualifying interaction scans by recorder + time.
-- Apply after 020_property_risk_history.sql.
--
-- Qualifying rows require owner_id and exclude archived interactions. The partial
-- index matches that filter so COUNT(DISTINCT owner_id) / GROUP BY recorder queries
-- avoid scanning non-qualifying rows.

create index if not exists interactions_org_recorder_occurred_qualifying_idx
  on public.interactions (organization_id, recorded_by_user_id, occurred_at desc)
  where owner_id is not null and archived_at is null;

comment on index public.interactions_org_recorder_occurred_qualifying_idx is
  'Supports Negotiator Activity KPI: org + recorder + occurred_at over qualifying (owner_id present, not archived) interactions.';

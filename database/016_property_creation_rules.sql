-- BizcaiaOS property creation rules (L-05).
-- Apply after 015_lifecycle_negotiation_exception.sql.
--
-- Creation stages are governed separately from ordinary transitions (P-6):
--
--   * Normal entry is identified. No controlled business entry point has
--     been approved, so identified is the only permitted entry stage for the
--     application; any other normal stage is reached afterwards through
--     transition_property_stage() (L-02/L-04).
--   * Legacy values (on_hold, withdrawn, acquisition_complete) are never valid
--     creation choices (P-6, X2-3).
--   * A new property starts in status active. Any other status is reached only
--     through transition_property_status() and its controlled matrix (X2-4,
--     N-2); creating a property as complete would bypass the P-3 completion
--     condition and its explicit completion transition.
--
-- The guard applies to the application role. An owner context (migrations
-- and other controlled administrative operations, as for the 013/014 guards)
-- is not restricted. Creation authority, tenant and project checks,
-- assignment roles, the (organization_id, property_reference) uniqueness, and
-- the L-01 creation history entry are unchanged. Not handled here: legacy
-- remediation, stale-screen protection, and UI.

create or replace function public.enforce_property_creation_rules()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if public.is_property_owner_context() then
    return new;
  end if;

  if new.acquisition_stage <> 'identified' then
    raise exception 'A property can only be created in the identified stage (requested %)', new.acquisition_stage
      using errcode = '22023';
  end if;

  if new.acquisition_status <> 'active' then
    raise exception 'A property can only be created with status active (requested %)', new.acquisition_status
      using errcode = '22023';
  end if;

  return new;
end;
$$;

drop trigger if exists properties_creation_guard on public.properties;
create trigger properties_creation_guard
before insert on public.properties
for each row execute function public.enforce_property_creation_rules();

comment on function public.enforce_property_creation_rules() is
  'P-6 creation rules: the application creates properties only in stage identified and status active; later stages and statuses go through the transition functions.';

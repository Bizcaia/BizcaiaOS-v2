-- BizcaiaOS role-based access control and row-level security
-- Apply after 001_core_schema.sql.
--
-- Authentication contract:
-- 1. Supabase/PostgREST requests resolve app_users.auth_subject from the verified
--    request.jwt.claim.sub claim.
-- 2. A trusted application server may instead SET LOCAL app.user_id after it has
--    verified the session. Never expose a direct database credential that lets an
--    untrusted client choose app.user_id.

-- Resolve the application user from a verified JWT subject when available, with a
-- trusted-server UUID setting as the fallback.
create or replace function public.current_app_user_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    (
      select u.id
      from public.app_users u
      where u.auth_subject = nullif(current_setting('request.jwt.claim.sub', true), '')
      limit 1
    ),
    nullif(current_setting('app.user_id', true), '')::uuid
  );
$$;

create or replace function public.current_org_role(target_org uuid)
returns public.organization_role
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select m.role
  from public.organization_memberships m
  where m.organization_id = target_org
    and m.user_id = public.current_app_user_id()
    and m.is_active = true
  limit 1;
$$;

create or replace function public.has_org_role(
  target_org uuid,
  allowed_roles public.organization_role[]
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(public.current_org_role(target_org) = any(allowed_roles), false);
$$;

create or replace function public.project_belongs_to_org(
  target_project uuid,
  target_org uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.projects p
    where p.id = target_project
      and p.organization_id = target_org
  );
$$;

create or replace function public.is_project_manager(
  target_project uuid,
  target_user uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.projects p
    where p.id = target_project
      and p.manager_user_id = target_user
  );
$$;

create or replace function public.shares_active_organization_with(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.organization_memberships mine
    join public.organization_memberships theirs
      on theirs.organization_id = mine.organization_id
    where mine.user_id = public.current_app_user_id()
      and mine.is_active = true
      and theirs.user_id = target_user
      and theirs.is_active = true
  );
$$;

create or replace function public.can_read_property(
  target_org uuid,
  target_project uuid,
  property_negotiator uuid,
  property_manager uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  actor uuid := public.current_app_user_id();
  actor_role public.organization_role := public.current_org_role(target_org);
begin
  if actor is null or actor_role is null then
    return false;
  end if;

  case actor_role
    when 'system_admin' then return true;
    when 'land_acquisition_manager' then return true;
    when 'legal_documentation' then return true;
    when 'finance' then return true;
    when 'viewer' then return true;
    when 'supervisor' then
      return property_manager = actor or public.is_project_manager(target_project, actor);
    when 'negotiator' then
      return property_negotiator = actor;
    else
      return false;
  end case;
end;
$$;

create or replace function public.can_create_property(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.has_org_role(
    target_org,
    array[
      'system_admin'::public.organization_role,
      'land_acquisition_manager'::public.organization_role
    ]
  );
$$;

create or replace function public.can_update_property(
  target_org uuid,
  target_project uuid,
  property_negotiator uuid,
  property_manager uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  actor uuid := public.current_app_user_id();
  actor_role public.organization_role := public.current_org_role(target_org);
begin
  if actor is null or actor_role is null then
    return false;
  end if;

  case actor_role
    when 'system_admin' then return true;
    when 'land_acquisition_manager' then return true;
    when 'legal_documentation' then return true;
    when 'finance' then return true;
    when 'supervisor' then
      return property_manager = actor or public.is_project_manager(target_project, actor);
    else
      return false;
  end case;
end;
$$;

-- Validate tenant boundaries and assignment roles independently of the UI.
create or replace function public.enforce_property_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.project_belongs_to_org(new.project_id, new.organization_id) then
    raise exception 'Property project must belong to the same organization'
      using errcode = '23514';
  end if;

  if new.assigned_negotiator_id is not null and not exists (
    select 1
    from public.organization_memberships m
    where m.organization_id = new.organization_id
      and m.user_id = new.assigned_negotiator_id
      and m.is_active = true
      and m.role = 'negotiator'
  ) then
    raise exception 'Assigned negotiator must be an active negotiator in the property organization'
      using errcode = '23514';
  end if;

  if new.assigned_manager_id is not null and not exists (
    select 1
    from public.organization_memberships m
    where m.organization_id = new.organization_id
      and m.user_id = new.assigned_manager_id
      and m.is_active = true
      and m.role in ('system_admin', 'land_acquisition_manager', 'supervisor')
  ) then
    raise exception 'Assigned manager must be an active manager or supervisor in the property organization'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function public.protect_last_system_admin()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  remaining_admins integer;
  removing_admin boolean := false;
begin
  if old.role = 'system_admin' and old.is_active = true then
    if tg_op = 'DELETE' then
      removing_admin := true;
    else
      removing_admin := new.role is distinct from 'system_admin'::public.organization_role
        or new.is_active is distinct from true;
    end if;
  end if;

  if removing_admin then
    select count(*)
      into remaining_admins
    from public.organization_memberships m
    where m.organization_id = old.organization_id
      and m.role = 'system_admin'
      and m.is_active = true
      and m.user_id <> old.user_id;

    if remaining_admins = 0 then
      raise exception 'An organization must retain at least one active System Administrator'
        using errcode = '23514';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if new.organization_id is distinct from old.organization_id
     or new.user_id is distinct from old.user_id then
    raise exception 'Membership identity cannot be changed; create a new membership instead'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- RLS controls which rows may be updated. This trigger additionally restricts
-- which property fields each permitted role may change.
create or replace function public.enforce_property_field_permissions()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_role public.organization_role := public.current_org_role(old.organization_id);
begin
  if actor_role is null then
    raise exception 'Active organization membership is required'
      using errcode = '42501';
  end if;

  -- Moving a property between tenants is never a normal update operation.
  if new.organization_id is distinct from old.organization_id then
    raise exception 'A property cannot be moved to another organization'
      using errcode = '42501';
  end if;

  if actor_role in ('system_admin', 'land_acquisition_manager') then
    return new;
  end if;

  if actor_role = 'supervisor' then
    if row(
      new.organization_id,
      new.project_id,
      new.property_reference,
      new.title_number,
      new.tax_declaration,
      new.lot_number,
      new.area_hectares,
      new.municipality,
      new.province,
      new.barangay,
      new.latitude,
      new.longitude,
      new.boundary_geojson,
      new.land_classification,
      new.zoning,
      new.acquisition_stage,
      new.acquisition_status,
      new.assigned_negotiator_id,
      new.assigned_manager_id,
      new.legal_status,
      new.documentation_status,
      new.payment_status,
      new.status
    ) is distinct from row(
      old.organization_id,
      old.project_id,
      old.property_reference,
      old.title_number,
      old.tax_declaration,
      old.lot_number,
      old.area_hectares,
      old.municipality,
      old.province,
      old.barangay,
      old.latitude,
      old.longitude,
      old.boundary_geojson,
      old.land_classification,
      old.zoning,
      old.acquisition_stage,
      old.acquisition_status,
      old.assigned_negotiator_id,
      old.assigned_manager_id,
      old.legal_status,
      old.documentation_status,
      old.payment_status,
      old.status
    ) then
      raise exception 'Supervisors may update only readiness, risk, and operational metadata'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if actor_role = 'legal_documentation' then
    if row(
      new.organization_id,
      new.project_id,
      new.property_reference,
      new.title_number,
      new.tax_declaration,
      new.lot_number,
      new.area_hectares,
      new.municipality,
      new.province,
      new.barangay,
      new.latitude,
      new.longitude,
      new.boundary_geojson,
      new.land_classification,
      new.zoning,
      new.acquisition_stage,
      new.acquisition_status,
      new.assigned_negotiator_id,
      new.assigned_manager_id,
      new.payment_status,
      new.readiness_percent,
      new.risk,
      new.status,
      new.metadata
    ) is distinct from row(
      old.organization_id,
      old.project_id,
      old.property_reference,
      old.title_number,
      old.tax_declaration,
      old.lot_number,
      old.area_hectares,
      old.municipality,
      old.province,
      old.barangay,
      old.latitude,
      old.longitude,
      old.boundary_geojson,
      old.land_classification,
      old.zoning,
      old.acquisition_stage,
      old.acquisition_status,
      old.assigned_negotiator_id,
      old.assigned_manager_id,
      old.payment_status,
      old.readiness_percent,
      old.risk,
      old.status,
      old.metadata
    ) then
      raise exception 'Legal / Documentation may update only legal and documentation status fields'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if actor_role = 'finance' then
    if row(
      new.organization_id,
      new.project_id,
      new.property_reference,
      new.title_number,
      new.tax_declaration,
      new.lot_number,
      new.area_hectares,
      new.municipality,
      new.province,
      new.barangay,
      new.latitude,
      new.longitude,
      new.boundary_geojson,
      new.land_classification,
      new.zoning,
      new.acquisition_stage,
      new.acquisition_status,
      new.assigned_negotiator_id,
      new.assigned_manager_id,
      new.legal_status,
      new.documentation_status,
      new.readiness_percent,
      new.risk,
      new.status,
      new.metadata
    ) is distinct from row(
      old.organization_id,
      old.project_id,
      old.property_reference,
      old.title_number,
      old.tax_declaration,
      old.lot_number,
      old.area_hectares,
      old.municipality,
      old.province,
      old.barangay,
      old.latitude,
      old.longitude,
      old.boundary_geojson,
      old.land_classification,
      old.zoning,
      old.acquisition_stage,
      old.acquisition_status,
      old.assigned_negotiator_id,
      old.assigned_manager_id,
      old.legal_status,
      old.documentation_status,
      old.readiness_percent,
      old.risk,
      old.status,
      old.metadata
    ) then
      raise exception 'Finance may update only payment status'
        using errcode = '42501';
    end if;
    return new;
  end if;

  raise exception 'Role % cannot update properties', actor_role
    using errcode = '42501';
end;
$$;

create trigger properties_scope_guard
before insert or update on public.properties
for each row execute function public.enforce_property_scope();

create trigger properties_field_permission_guard
before update on public.properties
for each row execute function public.enforce_property_field_permissions();

create trigger organization_memberships_last_admin_guard
before update or delete on public.organization_memberships
for each row execute function public.protect_last_system_admin();

-- Replace the broad member-read policies from the initial migration.
drop policy if exists organization_member_read on public.organizations;
drop policy if exists organization_member_read on public.organization_memberships;
drop policy if exists organization_member_read on public.properties;

alter table public.organizations enable row level security;
alter table public.app_users enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.properties enable row level security;

-- PostgreSQL 15+ / Supabase: make this dashboard view enforce the querying
-- user's underlying property policies instead of using the view owner's rights.
alter view public.property_operating_view set (security_invoker = true);

-- Organizations are visible to active members. Organization profile changes are
-- restricted to System Administrators. Bootstrap creation remains a trusted
-- server/service operation because the first membership does not yet exist.
create policy organizations_select_member
on public.organizations
for select
using (public.is_org_member(id));

create policy organizations_update_system_admin
on public.organizations
for update
using (
  public.has_org_role(
    id,
    array['system_admin'::public.organization_role]
  )
)
with check (
  public.has_org_role(
    id,
    array['system_admin'::public.organization_role]
  )
);

create policy app_users_select_self_or_org_peer
on public.app_users
for select
using (
  id = public.current_app_user_id()
  or public.shares_active_organization_with(id)
);

-- Members can discover their organization roster. Only System Administrators may
-- add, change, deactivate, or remove organization memberships.
create policy organization_memberships_select_member
on public.organization_memberships
for select
using (public.is_org_member(organization_id));

create policy organization_memberships_insert_system_admin
on public.organization_memberships
for insert
with check (
  public.has_org_role(
    organization_id,
    array['system_admin'::public.organization_role]
  )
);

create policy organization_memberships_update_system_admin
on public.organization_memberships
for update
using (
  public.has_org_role(
    organization_id,
    array['system_admin'::public.organization_role]
  )
)
with check (
  public.has_org_role(
    organization_id,
    array['system_admin'::public.organization_role]
  )
);

create policy organization_memberships_delete_system_admin
on public.organization_memberships
for delete
using (
  public.has_org_role(
    organization_id,
    array['system_admin'::public.organization_role]
  )
);

-- Property visibility combines role, organization, project responsibility, and
-- direct property assignment. A negotiator sees only assigned properties; a
-- supervisor sees managed/project-managed properties; organization-wide roles
-- see the full organization portfolio.
create policy properties_select_authorized
on public.properties
for select
using (
  public.can_read_property(
    organization_id,
    project_id,
    assigned_negotiator_id,
    assigned_manager_id
  )
);

create policy properties_insert_manager
on public.properties
for insert
with check (
  public.can_create_property(organization_id)
  and public.project_belongs_to_org(project_id, organization_id)
);

create policy properties_update_authorized
on public.properties
for update
using (
  public.can_update_property(
    organization_id,
    project_id,
    assigned_negotiator_id,
    assigned_manager_id
  )
)
with check (
  public.can_update_property(
    organization_id,
    project_id,
    assigned_negotiator_id,
    assigned_manager_id
  )
  and public.project_belongs_to_org(project_id, organization_id)
);

create policy properties_delete_system_admin
on public.properties
for delete
using (
  public.has_org_role(
    organization_id,
    array['system_admin'::public.organization_role]
  )
);

comment on function public.current_org_role(uuid) is 'Returns the active organization role for the authenticated application user.';
comment on function public.can_read_property(uuid, uuid, uuid, uuid) is 'Evaluates organization role, project management, and property assignment for property visibility.';
comment on function public.can_update_property(uuid, uuid, uuid, uuid) is 'Evaluates whether a role may attempt a property update; a trigger enforces field-level responsibility.';
comment on function public.enforce_property_field_permissions() is 'Prevents permitted roles from changing property fields outside their functional responsibility.';

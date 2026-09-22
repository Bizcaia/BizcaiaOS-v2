-- BizcaiaOS property-workflow RLS for owners and property_owners
-- Apply after 003_organization_onboarding.sql.
-- Does not alter property field-level permissions from 002_rbac_rls.sql.

create or replace function public.can_manage_owners(target_org uuid)
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

create or replace function public.enforce_property_owner_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  property_org uuid;
  owner_org uuid;
begin
  select p.organization_id into property_org
  from public.properties p
  where p.id = new.property_id;

  if property_org is null then
    raise exception 'Property not found for owner link'
      using errcode = 'P0002';
  end if;

  select o.organization_id into owner_org
  from public.owners o
  where o.id = new.owner_id;

  if owner_org is null then
    raise exception 'Owner not found for property link'
      using errcode = 'P0002';
  end if;

  if owner_org is distinct from property_org then
    raise exception 'Owner must belong to the same organization as the property'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create unique index if not exists property_owners_one_primary_per_property
on public.property_owners (property_id)
where is_primary = true;

drop trigger if exists property_owners_scope_guard on public.property_owners;
create trigger property_owners_scope_guard
before insert or update on public.property_owners
for each row execute function public.enforce_property_owner_scope();

alter table public.owners enable row level security;
alter table public.property_owners enable row level security;

drop policy if exists owners_insert_managers on public.owners;
drop policy if exists owners_update_managers on public.owners;
drop policy if exists owners_delete_managers on public.owners;
drop policy if exists property_owners_insert_managers on public.property_owners;
drop policy if exists property_owners_update_managers on public.property_owners;
drop policy if exists property_owners_delete_managers on public.property_owners;

create policy owners_insert_managers
on public.owners
for insert
with check (public.can_manage_owners(organization_id));

create policy owners_update_managers
on public.owners
for update
using (public.can_manage_owners(organization_id))
with check (public.can_manage_owners(organization_id));

create policy owners_delete_managers
on public.owners
for delete
using (public.can_manage_owners(organization_id));

create policy property_owners_insert_managers
on public.property_owners
for insert
with check (
  exists (
    select 1
    from public.properties p
    where p.id = property_id
      and public.can_manage_owners(p.organization_id)
  )
);

create policy property_owners_update_managers
on public.property_owners
for update
using (
  exists (
    select 1
    from public.properties p
    where p.id = property_id
      and public.can_manage_owners(p.organization_id)
  )
)
with check (
  exists (
    select 1
    from public.properties p
    where p.id = property_id
      and public.can_manage_owners(p.organization_id)
  )
);

create policy property_owners_delete_managers
on public.property_owners
for delete
using (
  exists (
    select 1
    from public.properties p
    where p.id = property_id
      and public.can_manage_owners(p.organization_id)
  )
);

comment on function public.can_manage_owners(uuid) is
  'System Administrators and Land Acquisition Managers may create, update, delete, and link owners.';
comment on function public.enforce_property_owner_scope() is
  'Rejects property-owner links that cross organization boundaries.';

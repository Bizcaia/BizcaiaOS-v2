-- Project write policy for the existing ops API.
-- 001/002 only provided member SELECT on public.projects. A non-owner
-- application role therefore cannot INSERT projects until this policy exists.
-- Apply after 004_property_workflow_rls.sql.

create policy projects_insert_managers
on public.projects
for insert
with check (
  public.has_org_role(
    organization_id,
    array[
      'system_admin'::public.organization_role,
      'land_acquisition_manager'::public.organization_role
    ]
  )
);

comment on policy projects_insert_managers on public.projects is
  'System Administrators and Land Acquisition Managers may create projects in their organization.';

-- BizcaiaOS tasks: property-scoped operational follow-up items.
-- Apply after 007_documents.sql.
--
-- v1 scope: every task belongs to a property. No polymorphic attachment, no
-- organization-wide/project-only/owner-only tasks. No recurring tasks,
-- subtasks, dependencies, comments, or templates. No automatic creation from
-- acquisition_stage transitions and no automatic completion from
-- property/document/negotiation state -- every status change is explicit.
--
-- Authorization (see docs discussion / technical contract for full reasoning):
--   system_admin, land_acquisition_manager  -> organization-wide task management
--   supervisor                              -> task management within managed property/project
--   negotiator                              -> self-assigned creation on their assigned property;
--                                              edit/complete/archive own assigned task; cannot reassign
--   legal_documentation, finance            -> self-assigned creation on ANY property in their org
--                                              (they already hold unconditional org-wide read); edit/
--                                              complete/archive own assigned task; cannot reassign or
--                                              manage another user's task
--   viewer                                  -> read only. Assignment must never grant write capability,
--                                              even for a task assigned to a viewer.
-- Only elevated task managers (system_admin/land_acquisition_manager/scoped supervisor) may reassign
-- a task (change assigned_user_id) after creation.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'task_status') then
    create type public.task_status as enum (
      'open',
      'in_progress',
      'done',
      'cancelled'
    );
  end if;

  -- Ordered low->urgent so `order by priority` sorts correctly using
  -- Postgres enum ordinal ordering, with no extra weighting logic.
  if not exists (select 1 from pg_type where typname = 'task_priority') then
    create type public.task_priority as enum (
      'low',
      'normal',
      'high',
      'urgent'
    );
  end if;
end
$$;

create table if not exists public.tasks (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  property_id         uuid not null references public.properties(id) on delete restrict,
  title               text not null,
  description         text,
  status              public.task_status not null default 'open',
  priority            public.task_priority not null default 'normal',
  assigned_user_id    uuid references public.app_users(id) on delete set null,
  due_on              date,
  created_by_user_id  uuid not null references public.app_users(id) on delete restrict,
  created_at          timestamptz not null default timezone('utc', now()),
  updated_at          timestamptz not null default timezone('utc', now()),
  archived_at         timestamptz,
  check (length(title) > 0)
);

create index if not exists tasks_org_property_idx on public.tasks (organization_id, property_id);
create index if not exists tasks_assignee_idx on public.tasks (assigned_user_id) where assigned_user_id is not null;

drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at before update on public.tasks
  for each row execute function public.set_updated_at();

-- Elevated task management: system_admin/LAM organization-wide, supervisor
-- scoped to a managed property/project. Deliberately NOT a reuse of
-- can_update_property -- that function also returns true for
-- legal_documentation/finance at the row level (their narrowing happens in a
-- separate trigger there), which would wrongly grant them general task
-- management here. This mirrors can_update_property's shape without
-- inheriting its legal/finance branch.
create or replace function public.can_manage_tasks(
  target_org uuid,
  target_project uuid,
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

  if actor_role in ('system_admin', 'land_acquisition_manager') then
    return true;
  end if;

  if actor_role = 'supervisor' then
    return property_manager = actor or public.is_project_manager(target_project, actor);
  end if;

  return false;
end;
$$;

-- Self-service write on one's own assigned task. Viewer is explicitly
-- excluded: assignment must never implicitly elevate a viewer's permissions.
create or replace function public.can_write_own_task(target_org uuid, task_assignee uuid)
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
  if actor is null or actor_role is null or actor_role = 'viewer' then
    return false;
  end if;
  return task_assignee is not null and task_assignee = actor;
end;
$$;

-- Read floor = property visibility, extended so an assignee always sees
-- their own task even without broader property access (mirrors
-- can_read_negotiation's assignee OR-branch). This exception is per-row (it
-- only ever matches the one task where assigned_user_id = actor), so it
-- cannot expose any other task on the same property.
create or replace function public.can_read_task(target_property uuid, task_assignee uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  property_org uuid;
  property_project uuid;
  property_negotiator uuid;
  property_manager uuid;
begin
  select p.organization_id, p.project_id, p.assigned_negotiator_id, p.assigned_manager_id
    into property_org, property_project, property_negotiator, property_manager
    from public.properties p
   where p.id = target_property;

  if property_org is null then
    return false;
  end if;

  if public.can_read_property(property_org, property_project, property_negotiator, property_manager) then
    return true;
  end if;

  return task_assignee is not null and task_assignee = public.current_app_user_id();
end;
$$;

-- Creation: elevated managers create for anyone (or leave unassigned); a
-- property-assigned negotiator, or a legal_documentation/finance member, may
-- create only a task assigned to themselves. legal_documentation/finance
-- have no property-assignment condition -- they already hold unconditional
-- org-wide read, so there is no equivalent "assigned property" field to gate
-- on. Viewer falls through to false in every branch.
create or replace function public.can_create_task(
  target_org uuid,
  target_property uuid,
  requested_assignee uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  property_org uuid;
  property_project uuid;
  property_manager uuid;
  property_negotiator uuid;
  actor uuid := public.current_app_user_id();
  actor_role public.organization_role := public.current_org_role(target_org);
begin
  if actor is null or actor_role is null then
    return false;
  end if;

  select p.organization_id, p.project_id, p.assigned_manager_id, p.assigned_negotiator_id
    into property_org, property_project, property_manager, property_negotiator
    from public.properties p
   where p.id = target_property;

  if property_org is null or property_org is distinct from target_org then
    return false;
  end if;

  if public.can_manage_tasks(target_org, property_project, property_manager) then
    return true;
  end if;

  if actor_role = 'negotiator' and property_negotiator = actor and requested_assignee = actor then
    return true;
  end if;

  if actor_role in ('legal_documentation', 'finance') and requested_assignee = actor then
    return true;
  end if;

  return false;
end;
$$;

create or replace function public.enforce_task_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  property_org uuid;
begin
  select p.organization_id into property_org
    from public.properties p
   where p.id = new.property_id;

  if property_org is null then
    raise exception 'Property not found for task'
      using errcode = 'P0002';
  end if;

  if property_org is distinct from new.organization_id then
    raise exception 'Task must belong to the same organization as the property'
      using errcode = '23514';
  end if;

  if new.assigned_user_id is not null and not exists (
    select 1
    from public.organization_memberships m
    where m.organization_id = new.organization_id
      and m.user_id = new.assigned_user_id
      and m.is_active = true
  ) then
    raise exception 'Assigned user must be an active member of the task organization'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    if new.organization_id is distinct from old.organization_id
       or new.property_id is distinct from old.property_id then
      raise exception 'Task organization and property cannot be changed'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists tasks_scope_guard on public.tasks;
create trigger tasks_scope_guard
before insert or update on public.tasks
for each row execute function public.enforce_task_scope();

create or replace function public.enforce_task_field_permissions()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  property_manager uuid;
  property_project uuid;
begin
  select p.assigned_manager_id, p.project_id into property_manager, property_project
    from public.properties p
   where p.id = old.property_id;

  if public.can_manage_tasks(old.organization_id, property_project, property_manager) then
    return new; -- elevated managers: no further restriction
  end if;

  if public.can_write_own_task(old.organization_id, old.assigned_user_id) then
    if new.assigned_user_id is distinct from old.assigned_user_id then
      raise exception 'Only elevated task managers may reassign a task'
        using errcode = '42501';
    end if;
    return new; -- self-service: every other field is writable
  end if;

  raise exception 'You do not have permission to update this task'
    using errcode = '42501';
end;
$$;

drop trigger if exists tasks_field_permissions_guard on public.tasks;
create trigger tasks_field_permissions_guard
before update on public.tasks
for each row execute function public.enforce_task_field_permissions();

alter table public.tasks enable row level security;

drop policy if exists tasks_select_visible on public.tasks;
drop policy if exists tasks_insert_authorized on public.tasks;
drop policy if exists tasks_update_authorized on public.tasks;

create policy tasks_select_visible
on public.tasks
for select
using (public.can_read_task(property_id, assigned_user_id));

create policy tasks_insert_authorized
on public.tasks
for insert
with check (public.can_create_task(organization_id, property_id, assigned_user_id));

create policy tasks_update_authorized
on public.tasks
for update
using (
  public.can_manage_tasks(
    organization_id,
    (select project_id from public.properties where id = property_id),
    (select assigned_manager_id from public.properties where id = property_id)
  )
  or public.can_write_own_task(organization_id, assigned_user_id)
)
with check (
  public.can_manage_tasks(
    organization_id,
    (select project_id from public.properties where id = property_id),
    (select assigned_manager_id from public.properties where id = property_id)
  )
  or public.can_write_own_task(organization_id, assigned_user_id)
);

comment on table public.tasks is
  'Property-scoped operational follow-up items. Always belongs to a property; no polymorphic attachment.';
comment on function public.can_read_task(uuid, uuid) is
  'Task visibility follows property visibility, plus the current assignee seeing their own task regardless of broader property access.';
comment on function public.can_manage_tasks(uuid, uuid, uuid) is
  'System Administrators and Land Acquisition Managers manage tasks organization-wide; supervisors within a managed property/project.';
comment on function public.can_write_own_task(uuid, uuid) is
  'Self-service write for the current assignee on their own task. Viewer is excluded: assignment must never grant write capability.';
comment on function public.can_create_task(uuid, uuid, uuid) is
  'Elevated managers create for anyone; a property-assigned negotiator or a legal_documentation/finance member may create only a self-assigned task.';
comment on function public.enforce_task_scope() is
  'Enforces tenant match, active-member assignee validation, and immutability of organization_id/property_id after insert.';
comment on function public.enforce_task_field_permissions() is
  'Elevated managers may change any field including reassignment; the current assignee may change every field except assigned_user_id.';

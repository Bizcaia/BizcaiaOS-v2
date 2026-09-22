-- BizcaiaOS core operational schema
-- PostgreSQL / Supabase-compatible migration
-- Scope: organizations, users/memberships, projects, properties, owners,
-- negotiations, and append-only negotiation events.

create extension if not exists pgcrypto;

create type public.organization_role as enum (
  'system_admin',
  'land_acquisition_manager',
  'supervisor',
  'negotiator',
  'legal_documentation',
  'finance',
  'viewer'
);

create type public.project_status as enum ('planning', 'active', 'paused', 'completed', 'archived');

create type public.acquisition_stage as enum (
  'identified',
  'initial_contact',
  'owner_validation',
  'property_validation',
  'documentation',
  'negotiation',
  'commercial_review',
  'legal_review',
  'agreement_preparation',
  'signing',
  'payment_closing',
  'acquisition_complete',
  'on_hold',
  'withdrawn'
);

create type public.acquisition_status as enum ('active', 'on_hold', 'withdrawn', 'complete');
create type public.property_risk as enum ('low', 'medium', 'high');
create type public.legal_status as enum ('unknown', 'clear', 'under_review', 'blocked');
create type public.record_status as enum ('active', 'archived');
create type public.negotiation_status as enum ('open', 'paused', 'accepted', 'rejected', 'withdrawn', 'closed');
create type public.negotiation_event_type as enum ('offer', 'counteroffer', 'meeting', 'call', 'message', 'note', 'other');

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  legal_name text,
  timezone text not null default 'Asia/Manila',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.app_users (
  id uuid primary key default gen_random_uuid(),
  auth_subject text not null unique,
  display_name text not null,
  email text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.organization_memberships (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.app_users(id) on delete cascade,
  role public.organization_role not null default 'viewer',
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, user_id)
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code text not null,
  name text not null,
  description text,
  status public.project_status not null default 'planning',
  geographic_scope jsonb not null default '{}'::jsonb,
  acquisition_target numeric(14, 2),
  manager_user_id uuid references public.app_users(id) on delete set null,
  starts_on date,
  target_completion_on date,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, code),
  check (acquisition_target is null or acquisition_target >= 0),
  check (target_completion_on is null or starts_on is null or target_completion_on >= starts_on)
);

create table public.owners (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  owner_type text not null check (owner_type in ('individual', 'corporate', 'estate', 'government', 'other')),
  display_name text not null,
  organization_name text,
  contact_details jsonb not null default '{}'::jsonb,
  legal_evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.properties (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete restrict,
  property_reference text not null,
  title_number text,
  tax_declaration text,
  lot_number text,
  area_hectares numeric(14, 4),
  municipality text,
  province text,
  barangay text,
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  boundary_geojson jsonb,
  land_classification text,
  zoning text,
  acquisition_stage public.acquisition_stage not null default 'identified',
  acquisition_status public.acquisition_status not null default 'active',
  assigned_negotiator_id uuid references public.app_users(id) on delete set null,
  assigned_manager_id uuid references public.app_users(id) on delete set null,
  legal_status public.legal_status not null default 'unknown',
  documentation_status text not null default 'not_started',
  payment_status text not null default 'not_started',
  readiness_percent integer not null default 0 check (readiness_percent between 0 and 100),
  risk public.property_risk not null default 'medium',
  status public.record_status not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, property_reference),
  check (area_hectares is null or area_hectares >= 0),
  check (latitude is null or latitude between -90 and 90),
  check (longitude is null or longitude between -180 and 180)
);

create table public.property_owners (
  property_id uuid not null references public.properties(id) on delete cascade,
  owner_id uuid not null references public.owners(id) on delete restrict,
  ownership_percent numeric(5, 2),
  is_primary boolean not null default false,
  evidence_document_id uuid,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (property_id, owner_id),
  check (ownership_percent is null or (ownership_percent >= 0 and ownership_percent <= 100))
);

create table public.negotiations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  status public.negotiation_status not null default 'open',
  assigned_negotiator_id uuid references public.app_users(id) on delete set null,
  opening_amount numeric(14, 2),
  target_amount numeric(14, 2),
  current_amount numeric(14, 2),
  currency_code char(3) not null default 'PHP',
  started_at timestamptz not null default timezone('utc', now()),
  closed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (opening_amount is null or opening_amount >= 0),
  check (target_amount is null or target_amount >= 0),
  check (current_amount is null or current_amount >= 0),
  check (closed_at is null or closed_at >= started_at)
);

create unique index negotiations_one_open_per_property
  on public.negotiations (property_id)
  where status in ('open', 'paused');

create table public.negotiation_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  negotiation_id uuid not null references public.negotiations(id) on delete restrict,
  event_type public.negotiation_event_type not null,
  amount numeric(14, 2),
  actor_user_id uuid not null references public.app_users(id) on delete restrict,
  contextual_note text,
  occurred_at timestamptz not null default timezone('utc', now()),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  check (amount is null or amount >= 0),
  check ((event_type in ('offer', 'counteroffer') and amount is not null) or event_type not in ('offer', 'counteroffer'))
);

create or replace function public.prevent_negotiation_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Negotiation events are append-only; create a new event instead';
end;
$$;

create trigger negotiation_events_immutable_update
before update on public.negotiation_events
for each row execute function public.prevent_negotiation_event_mutation();

create trigger negotiation_events_immutable_delete
before delete on public.negotiation_events
for each row execute function public.prevent_negotiation_event_mutation();

create trigger organizations_set_updated_at before update on public.organizations for each row execute function public.set_updated_at();
create trigger app_users_set_updated_at before update on public.app_users for each row execute function public.set_updated_at();
create trigger projects_set_updated_at before update on public.projects for each row execute function public.set_updated_at();
create trigger owners_set_updated_at before update on public.owners for each row execute function public.set_updated_at();
create trigger properties_set_updated_at before update on public.properties for each row execute function public.set_updated_at();
create trigger negotiations_set_updated_at before update on public.negotiations for each row execute function public.set_updated_at();

create index projects_org_idx on public.projects (organization_id, status);
create index owners_org_idx on public.owners (organization_id, display_name);
create index properties_org_project_idx on public.properties (organization_id, project_id, acquisition_stage);
create index properties_assignment_idx on public.properties (assigned_negotiator_id, acquisition_status);
create index property_owners_owner_idx on public.property_owners (owner_id);
create index negotiations_property_idx on public.negotiations (property_id, status);
create index negotiation_events_timeline_idx on public.negotiation_events (negotiation_id, occurred_at desc);

-- Useful read model for the dashboard. It keeps the property as the source of truth.
create view public.property_operating_view as
select
  p.id,
  p.organization_id,
  p.project_id,
  p.property_reference,
  p.municipality,
  p.province,
  p.acquisition_stage,
  p.acquisition_status,
  p.readiness_percent,
  p.risk,
  p.assigned_negotiator_id,
  count(distinct po.owner_id) as owner_count,
  count(distinct n.id) filter (where n.status in ('open', 'paused')) as active_negotiation_count,
  max(ne.occurred_at) as last_negotiation_event_at
from public.properties p
left join public.property_owners po on po.property_id = p.id
left join public.negotiations n on n.property_id = p.id
left join public.negotiation_events ne on ne.negotiation_id = n.id
group by p.id;

-- RLS helper. The application must set app.user_id per request after authentication.
create or replace function public.current_app_user_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid;
$$;

create or replace function public.is_org_member(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_memberships m
    where m.organization_id = target_org
      and m.user_id = public.current_app_user_id()
      and m.is_active = true
  );
$$;

alter table public.organizations enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.projects enable row level security;
alter table public.owners enable row level security;
alter table public.properties enable row level security;
alter table public.property_owners enable row level security;
alter table public.negotiations enable row level security;
alter table public.negotiation_events enable row level security;

create policy organization_member_read on public.organizations
  for select using (public.is_org_member(id));
create policy organization_member_read on public.organization_memberships
  for select using (public.is_org_member(organization_id));
create policy organization_member_read on public.projects
  for select using (public.is_org_member(organization_id));
create policy organization_member_read on public.owners
  for select using (public.is_org_member(organization_id));
create policy organization_member_read on public.properties
  for select using (public.is_org_member(organization_id));
create policy organization_member_read on public.property_owners
  for select using (exists (select 1 from public.properties p where p.id = property_id and public.is_org_member(p.organization_id)));
create policy organization_member_read on public.negotiations
  for select using (public.is_org_member(organization_id));
create policy organization_member_read on public.negotiation_events
  for select using (public.is_org_member(organization_id));

comment on table public.properties is 'Central operational aggregate for land acquisition. Connected records should reference this table rather than duplicate property truth.';
comment on table public.negotiation_events is 'Append-only record of offers, counteroffers, and negotiation interactions.';
comment on function public.current_app_user_id() is 'Set app.user_id per authenticated request before querying protected tables.';

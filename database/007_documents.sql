-- BizcaiaOS documents: property-scoped document registry with real file storage.
-- Apply after 006_negotiations_rls.sql.
--
-- v1 scope: documents always belong to a property. negotiation_id is an optional
-- narrowing (the negotiation must belong to the same property), not a new
-- attachment axis. No polymorphic entity_type/entity_id design.
--
-- storage_provider/storage_key are opaque server-set metadata pointing at a
-- DocumentStorage implementation; the database never stores a filesystem path
-- or provider URL, and storage_provider is never client-editable (enforced by
-- the immutability trigger below, not just by the API).
--
-- Read visibility follows property visibility exactly (public.can_read_property),
-- with no category-based narrowing. Write access is restricted to
-- system_admin, land_acquisition_manager, and legal_documentation -- the same
-- roles that already own properties.documentation_status.
--
-- properties.documentation_status and property_owners.evidence_document_id are
-- intentionally untouched by this migration. document.status is not coupled to
-- properties.acquisition_stage or properties.documentation_status in any way.

-- Types and the base table are guarded for idempotency: integration tests
-- re-apply this file's policy/function layer under the migration advisory
-- lock even after schema_migrations already recorded it, the same way
-- 006_negotiations_rls.sql is re-applied, so on-disk definitions always match
-- what is actually loaded in the test database.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'document_category') then
    create type public.document_category as enum (
      'ownership_evidence',
      'title_deed',
      'tax_declaration',
      'legal_opinion',
      'survey_plan',
      'agreement_draft',
      'agreement_executed',
      'payment_proof',
      'other'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'document_status') then
    create type public.document_status as enum (
      'draft',
      'submitted',
      'under_review',
      'verified',
      'rejected',
      'superseded'
    );
  end if;
end
$$;

create table if not exists public.documents (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  property_id         uuid not null references public.properties(id) on delete restrict,
  negotiation_id      uuid references public.negotiations(id) on delete set null,
  category            public.document_category not null,
  status              public.document_status not null default 'draft',
  title               text not null,
  original_filename   text not null,
  content_type        text not null,
  size_bytes          integer not null check (size_bytes > 0),
  storage_provider    text not null default 'local',
  storage_key         text not null unique,
  uploaded_by_user_id uuid not null references public.app_users(id) on delete restrict,
  created_at          timestamptz not null default timezone('utc', now()),
  updated_at          timestamptz not null default timezone('utc', now()),
  archived_at         timestamptz,
  check (length(title) > 0)
);

create index if not exists documents_org_property_idx on public.documents (organization_id, property_id);
create index if not exists documents_negotiation_idx on public.documents (negotiation_id) where negotiation_id is not null;

drop trigger if exists documents_set_updated_at on public.documents;
create trigger documents_set_updated_at before update on public.documents
  for each row execute function public.set_updated_at();

-- Visibility follows property visibility exactly; no category-based narrowing.
create or replace function public.can_read_document(target_property uuid)
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

  return public.can_read_property(property_org, property_project, property_negotiator, property_manager);
end;
$$;

-- Write access is the same three roles that already own documentation_status.
create or replace function public.can_write_document(target_org uuid)
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
      'land_acquisition_manager'::public.organization_role,
      'legal_documentation'::public.organization_role
    ]
  );
$$;

create or replace function public.enforce_document_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  property_org uuid;
  negotiation_org uuid;
  negotiation_property uuid;
begin
  select p.organization_id into property_org
    from public.properties p
   where p.id = new.property_id;

  if property_org is null then
    raise exception 'Property not found for document'
      using errcode = 'P0002';
  end if;

  if property_org is distinct from new.organization_id then
    raise exception 'Document must belong to the same organization as the property'
      using errcode = '23514';
  end if;

  if new.negotiation_id is not null then
    select n.organization_id, n.property_id into negotiation_org, negotiation_property
      from public.negotiations n
     where n.id = new.negotiation_id;

    if negotiation_org is null then
      raise exception 'Negotiation not found for document'
        using errcode = 'P0002';
    end if;

    if negotiation_property is distinct from new.property_id then
      raise exception 'Document negotiation must belong to the same property'
        using errcode = '23514';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if new.organization_id is distinct from old.organization_id
       or new.property_id is distinct from old.property_id then
      raise exception 'Document organization and property cannot be changed'
        using errcode = '42501';
    end if;

    -- File identity and provenance are immutable after upload. storage_provider
    -- in particular must never be client-editable; this is the database-level
    -- backstop regardless of what the API layer allows through.
    if new.storage_provider is distinct from old.storage_provider
       or new.storage_key is distinct from old.storage_key
       or new.content_type is distinct from old.content_type
       or new.size_bytes is distinct from old.size_bytes
       or new.original_filename is distinct from old.original_filename
       or new.uploaded_by_user_id is distinct from old.uploaded_by_user_id then
      raise exception 'Document file identity is immutable; upload a new document instead'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists documents_scope_guard on public.documents;
create trigger documents_scope_guard
before insert or update on public.documents
for each row execute function public.enforce_document_scope();

alter table public.documents enable row level security;

drop policy if exists documents_select_visible on public.documents;
drop policy if exists documents_insert_authorized on public.documents;
drop policy if exists documents_update_authorized on public.documents;

create policy documents_select_visible
on public.documents
for select
using (public.can_read_document(property_id));

create policy documents_insert_authorized
on public.documents
for insert
with check (public.can_write_document(organization_id));

create policy documents_update_authorized
on public.documents
for update
using (public.can_write_document(organization_id))
with check (public.can_write_document(organization_id));

comment on table public.documents is
  'Property-scoped document registry. Always belongs to a property; negotiation_id is an optional narrowing, not a separate attachment axis.';
comment on column public.documents.storage_provider is
  'Server-set only. Never accept this value from a client request.';
comment on column public.documents.storage_key is
  'Opaque key resolved by the active DocumentStorage implementation. Never a filesystem path or provider URL.';
comment on function public.can_read_document(uuid) is
  'Document visibility follows property visibility exactly; no category-based narrowing in v1.';
comment on function public.can_write_document(uuid) is
  'System Administrators, Land Acquisition Managers, and Legal/Documentation write documents -- the same roles that own documentation_status.';
comment on function public.enforce_document_scope() is
  'Enforces tenant match, same-property negotiation linkage, and immutability of file identity fields after insert.';

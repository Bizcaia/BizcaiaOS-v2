-- BizcaiaOS agreement signatures: a record that a specific property owner
-- signed a specific executed agreement document.
-- Apply after 009_payments.sql.
--
-- A signature row IS the signing event -- there is no status enum and no
-- persistent "pending" state. Which owners have not signed a given document
-- is derived from property_owners minus active signature rows.
--
-- A property may have several agreement_executed documents and several
-- owners, so every signature is keyed to one document and one owner. At most
-- one active (non-archived) signature may exist per (document_id, owner_id);
-- archiving a signature permits a replacement for the same pair.
--
-- For every ACTIVE signature these hold continuously: the owner is linked to
-- the property through property_owners, and the document is an
-- agreement_executed document on the same property. They are checked on
-- insert and on re-activation, and parent-side guards refuse the owner-link
-- and document-category changes that would break them.
--
-- Authorization mirrors Documents exactly: system_admin,
-- land_acquisition_manager, and legal_documentation write; everyone else
-- reads through normal property visibility. No assignee model.
--
-- Recording signatures never changes acquisition_stage, acquisition_status,
-- legal_status, documentation_status, payment_status, Tasks, Negotiations,
-- or Payments. There is no "fully executed" gate.

create table if not exists public.agreement_signatures (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  property_id         uuid not null references public.properties(id) on delete restrict,
  document_id         uuid not null references public.documents(id) on delete restrict,
  owner_id            uuid not null references public.owners(id) on delete restrict,
  signed_on           date not null,
  recorded_by_user_id uuid not null references public.app_users(id) on delete restrict,
  created_at          timestamptz not null default timezone('utc', now()),
  updated_at          timestamptz not null default timezone('utc', now()),
  archived_at         timestamptz
);

create index if not exists agreement_signatures_org_property_idx
  on public.agreement_signatures (organization_id, property_id);

create unique index if not exists agreement_signatures_one_active_per_document_owner
  on public.agreement_signatures (document_id, owner_id)
  where archived_at is null;

drop trigger if exists agreement_signatures_set_updated_at on public.agreement_signatures;
create trigger agreement_signatures_set_updated_at before update on public.agreement_signatures
  for each row execute function public.set_updated_at();

-- Read floor = property visibility, with no widening.
create or replace function public.can_read_agreement_signature(target_property uuid)
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

-- Same fixed role set as can_write_document: verifying execution is the same
-- functional responsibility as managing the documents themselves.
create or replace function public.can_write_agreement_signature(target_org uuid)
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

create or replace function public.enforce_agreement_signature_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  property_org uuid;
  document_property uuid;
  document_kind public.document_category;
begin
  if tg_op = 'UPDATE' then
    -- Only archived_at may change (updated_at is maintained by its own
    -- trigger).
    if row(new.id, new.organization_id, new.property_id, new.document_id, new.owner_id,
           new.signed_on, new.recorded_by_user_id, new.created_at)
       is distinct from
       row(old.id, old.organization_id, old.property_id, old.document_id, old.owner_id,
           old.signed_on, old.recorded_by_user_id, old.created_at) then
      raise exception 'Agreement signatures are immutable; only archived_at may change'
        using errcode = '42501';
    end if;
    -- The relationship rules are continuous invariants of ACTIVE signatures.
    -- While a signature is active, the parent-side guards below keep them
    -- true; archiving needs no re-check. Re-activating an archived signature
    -- makes it active again, so it must pass the same checks as an insert.
    if not (old.archived_at is not null and new.archived_at is null) then
      return new;
    end if;
  end if;

  select p.organization_id into property_org
    from public.properties p
   where p.id = new.property_id;

  if property_org is null then
    raise exception 'Property not found for agreement signature'
      using errcode = 'P0002';
  end if;

  if property_org is distinct from new.organization_id then
    raise exception 'Agreement signature must belong to the same organization as the property'
      using errcode = '23514';
  end if;

  select d.property_id, d.category into document_property, document_kind
    from public.documents d
   where d.id = new.document_id;

  if document_property is null then
    raise exception 'Document not found for agreement signature'
      using errcode = 'P0002';
  end if;

  if document_property is distinct from new.property_id then
    raise exception 'Agreement signature document must belong to the same property'
      using errcode = '23514';
  end if;

  if document_kind is distinct from 'agreement_executed' then
    raise exception 'Agreement signatures may only reference an agreement_executed document'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.property_owners po
    where po.property_id = new.property_id
      and po.owner_id = new.owner_id
  ) then
    raise exception 'Signatory must be an existing owner of the property'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists agreement_signatures_scope_guard on public.agreement_signatures;
create trigger agreement_signatures_scope_guard
before insert or update on public.agreement_signatures
for each row execute function public.enforce_agreement_signature_scope();

-- Parent-side guards. An active signature's owner must remain an owner of
-- the property and its document must remain agreement_executed, so the
-- parent mutations that would break either are refused while an active
-- signature depends on them. Signatures are never archived automatically;
-- archive them first, then the parent change is allowed. These fire only
-- when an active signature exists, so owner and document behavior is
-- otherwise unchanged.
create or replace function public.guard_property_owner_agreement_signatures()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE'
     and new.property_id is not distinct from old.property_id
     and new.owner_id is not distinct from old.owner_id then
    return new;
  end if;

  if exists (
    select 1
    from public.agreement_signatures s
    where s.property_id = old.property_id
      and s.owner_id = old.owner_id
      and s.archived_at is null
  ) then
    raise exception 'This property owner has active agreement signatures; archive them before unlinking or changing the owner link'
      using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists property_owners_agreement_signature_guard on public.property_owners;
create trigger property_owners_agreement_signature_guard
before update or delete on public.property_owners
for each row execute function public.guard_property_owner_agreement_signatures();

create or replace function public.guard_document_agreement_signatures()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.category = 'agreement_executed'
     and new.category is distinct from old.category
     and exists (
       select 1
       from public.agreement_signatures s
       where s.document_id = old.id
         and s.archived_at is null
     ) then
    raise exception 'This document has active agreement signatures; archive them before changing its category'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists documents_agreement_signature_guard on public.documents;
create trigger documents_agreement_signature_guard
before update of category on public.documents
for each row execute function public.guard_document_agreement_signatures();

alter table public.agreement_signatures enable row level security;

drop policy if exists agreement_signatures_select_visible on public.agreement_signatures;
drop policy if exists agreement_signatures_insert_authorized on public.agreement_signatures;
drop policy if exists agreement_signatures_update_authorized on public.agreement_signatures;

create policy agreement_signatures_select_visible
on public.agreement_signatures
for select
using (public.can_read_agreement_signature(property_id));

create policy agreement_signatures_insert_authorized
on public.agreement_signatures
for insert
with check (public.can_write_agreement_signature(organization_id));

create policy agreement_signatures_update_authorized
on public.agreement_signatures
for update
using (public.can_write_agreement_signature(organization_id))
with check (public.can_write_agreement_signature(organization_id));

comment on table public.agreement_signatures is
  'A record that one property owner signed one agreement_executed document. The row is the signing event; unsigned owners are derived, not stored.';
comment on function public.can_read_agreement_signature(uuid) is
  'Agreement signature visibility follows property visibility exactly; no widening.';
comment on function public.can_write_agreement_signature(uuid) is
  'System Administrators, Land Acquisition Managers, and Legal/Documentation record and archive agreement signatures (same roles as documents).';
comment on function public.enforce_agreement_signature_scope() is
  'On insert and on re-activation: tenant match, same-property agreement_executed document, and an existing property_owners link. On update: every column except archived_at/updated_at is immutable.';
comment on function public.guard_property_owner_agreement_signatures() is
  'Refuses deleting or re-pointing a property_owners link while an active agreement signature depends on it.';
comment on function public.guard_document_agreement_signatures() is
  'Refuses changing an agreement_executed document''s category while active agreement signatures reference it.';

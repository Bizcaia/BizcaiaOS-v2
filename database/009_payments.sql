-- BizcaiaOS payments: property-scoped payment/disbursement ledger.
-- Apply after 008_tasks.sql.
--
-- v1 scope: every payment belongs to a property. No polymorphic attachment,
-- no organization-wide/project-only payments. No payment processing or
-- gateway integration -- this is a record-keeping ledger only. No refund
-- type yet (direction/accounting semantics are not defined by the current
-- model). No enforced status transition graph.
--
-- Authorization: system_admin, land_acquisition_manager, and finance read
-- and write, organization-wide. Everyone else (supervisor, negotiator,
-- legal_documentation, viewer) reads through normal property visibility
-- only. There is no assignee/self-service model for payments.
--
-- properties.payment_status is a pre-existing, separately-authorized field
-- (finance-controlled, enforced inside enforce_property_field_permissions()
-- in 002_rbac_rls.sql) and is intentionally untouched by this migration.
-- Nothing here modifies, renames, derives from, or synchronizes with it --
-- the two are deliberately independent: payment_status remains a coarse,
-- human-set summary; this table is the granular ledger behind it. Recording
-- a payment never changes acquisition_stage, payment_status, Task,
-- Negotiation, or Document state.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'payment_type') then
    create type public.payment_type as enum (
      'deposit',
      'installment',
      'final_payment'
    );
  end if;

  -- Named to match the document_status/task_status convention from prior
  -- slices. This is a TYPE name; it does not collide with the pre-existing
  -- properties.payment_status COLUMN (different namespace, different table,
  -- deliberately unrelated purpose -- see note above).
  if not exists (select 1 from pg_type where typname = 'payment_status') then
    create type public.payment_status as enum (
      'pending',
      'scheduled',
      'paid',
      'failed',
      'cancelled'
    );
  end if;
end
$$;

create table if not exists public.payments (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  property_id         uuid not null references public.properties(id) on delete restrict,
  negotiation_id      uuid references public.negotiations(id) on delete set null,
  amount              numeric(14, 2) not null check (amount > 0),
  currency_code       char(3) not null default 'PHP',
  payment_type        public.payment_type not null,
  status              public.payment_status not null default 'pending',
  scheduled_on        date,
  paid_on             date,
  reference_number    text,
  recorded_by_user_id uuid not null references public.app_users(id) on delete restrict,
  created_at          timestamptz not null default timezone('utc', now()),
  updated_at          timestamptz not null default timezone('utc', now()),
  archived_at         timestamptz
);

create index if not exists payments_org_property_idx on public.payments (organization_id, property_id);
create index if not exists payments_negotiation_idx on public.payments (negotiation_id) where negotiation_id is not null;

drop trigger if exists payments_set_updated_at on public.payments;
create trigger payments_set_updated_at before update on public.payments
  for each row execute function public.set_updated_at();

-- Read floor = property visibility, with no widening (payments have no
-- assignee concept, unlike documents/tasks).
create or replace function public.can_read_payment(target_property uuid)
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

-- Fixed write-role set, organization-wide. No supervisor/negotiator/legal
-- scope, and no assignee-based branching -- this deliberately mirrors
-- can_write_document's shape rather than can_manage_tasks's.
create or replace function public.can_write_payment(target_org uuid)
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
      'finance'::public.organization_role
    ]
  );
$$;

create or replace function public.enforce_payment_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  property_org uuid;
  negotiation_property uuid;
begin
  select p.organization_id into property_org
    from public.properties p
   where p.id = new.property_id;

  if property_org is null then
    raise exception 'Property not found for payment'
      using errcode = 'P0002';
  end if;

  if property_org is distinct from new.organization_id then
    raise exception 'Payment must belong to the same organization as the property'
      using errcode = '23514';
  end if;

  if new.negotiation_id is not null then
    select n.property_id into negotiation_property
      from public.negotiations n
     where n.id = new.negotiation_id;

    if negotiation_property is null then
      raise exception 'Negotiation not found for payment'
        using errcode = 'P0002';
    end if;

    if negotiation_property is distinct from new.property_id then
      raise exception 'Payment negotiation must belong to the same property'
        using errcode = '23514';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if new.organization_id is distinct from old.organization_id
       or new.property_id is distinct from old.property_id
       or new.recorded_by_user_id is distinct from old.recorded_by_user_id then
      raise exception 'Payment organization, property, and recorder are immutable after creation'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists payments_scope_guard on public.payments;
create trigger payments_scope_guard
before insert or update on public.payments
for each row execute function public.enforce_payment_scope();

alter table public.payments enable row level security;

drop policy if exists payments_select_visible on public.payments;
drop policy if exists payments_insert_authorized on public.payments;
drop policy if exists payments_update_authorized on public.payments;

create policy payments_select_visible
on public.payments
for select
using (public.can_read_payment(property_id));

create policy payments_insert_authorized
on public.payments
for insert
with check (public.can_write_payment(organization_id));

create policy payments_update_authorized
on public.payments
for update
using (public.can_write_payment(organization_id))
with check (public.can_write_payment(organization_id));

comment on table public.payments is
  'Property-scoped payment/disbursement ledger. Deliberately independent of properties.payment_status (a separate, pre-existing, finance-controlled summary field) -- no automatic relationship between the two.';
comment on function public.can_read_payment(uuid) is
  'Payment visibility follows property visibility exactly; no assignee-based widening.';
comment on function public.can_write_payment(uuid) is
  'System Administrators, Land Acquisition Managers, and Finance write payments organization-wide. No supervisor/negotiator/legal scope, no self-service model.';
comment on function public.enforce_payment_scope() is
  'Enforces tenant match, same-property negotiation linkage, and immutability of organization_id/property_id/recorded_by_user_id after insert.';

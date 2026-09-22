-- BizcaiaOS organization onboarding and user invitation support
-- Apply after 002_rbac_rls.sql.

create type public.organization_invitation_status as enum (
  'pending',
  'accepted',
  'revoked',
  'expired'
);

create unique index app_users_email_ci_unique
on public.app_users (lower(email));

create table public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  role public.organization_role not null,
  token_digest text not null unique,
  status public.organization_invitation_status not null default 'pending',
  invited_by_user_id uuid not null references public.app_users(id) on delete restrict,
  expires_at timestamptz not null,
  accepted_by_user_id uuid references public.app_users(id) on delete restrict,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (email = lower(email)),
  check (expires_at > created_at),
  check (
    (status = 'accepted' and accepted_by_user_id is not null and accepted_at is not null)
    or status <> 'accepted'
  )
);

create unique index organization_invitations_one_pending_per_email
on public.organization_invitations (organization_id, email)
where status = 'pending';

create index organization_invitations_org_status_idx
on public.organization_invitations (organization_id, status, expires_at);

create trigger organization_invitations_set_updated_at
before update on public.organization_invitations
for each row execute function public.set_updated_at();

create or replace function public.sync_authenticated_user(
  actor_auth_subject text,
  actor_display_name text,
  actor_email text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  resolved_user_id uuid;
begin
  if nullif(trim(actor_auth_subject), '') is null then
    raise exception 'Authenticated subject is required' using errcode = '22023';
  end if;

  if nullif(trim(actor_email), '') is null then
    raise exception 'Authenticated email is required' using errcode = '22023';
  end if;

  insert into public.app_users (auth_subject, display_name, email)
  values (
    actor_auth_subject,
    coalesce(nullif(trim(actor_display_name), ''), lower(trim(actor_email))),
    lower(trim(actor_email))
  )
  on conflict (auth_subject) do update
    set display_name = excluded.display_name,
        email = excluded.email,
        updated_at = timezone('utc', now())
  returning id into resolved_user_id;

  return resolved_user_id;
end;
$$;

-- Trusted bootstrap operation. The API calls this function in a transaction after
-- verifying the actor's identity. It creates the organization and first active
-- System Administrator membership atomically.
create or replace function public.bootstrap_organization(
  organization_name text,
  organization_slug text,
  actor_auth_subject text,
  actor_display_name text,
  actor_email text,
  organization_timezone text default 'Asia/Manila'
)
returns table (organization_id uuid, user_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  created_org_id uuid;
  resolved_user_id uuid;
begin
  if nullif(trim(organization_name), '') is null then
    raise exception 'Organization name is required' using errcode = '22023';
  end if;

  if organization_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'Organization slug is invalid' using errcode = '22023';
  end if;

  if nullif(trim(actor_auth_subject), '') is null then
    raise exception 'Authenticated subject is required' using errcode = '22023';
  end if;

  insert into public.app_users (auth_subject, display_name, email)
  values (actor_auth_subject, trim(actor_display_name), lower(trim(actor_email)))
  on conflict (auth_subject) do update
    set display_name = excluded.display_name,
        email = excluded.email,
        updated_at = timezone('utc', now())
  returning id into resolved_user_id;

  if exists (
    select 1
    from public.organization_memberships m
    where m.user_id = resolved_user_id
      and m.is_active = true
  ) then
    raise exception 'User already belongs to an active organization'
      using errcode = '23505';
  end if;

  insert into public.organizations (name, slug, timezone)
  values (trim(organization_name), organization_slug, organization_timezone)
  returning id into created_org_id;

  insert into public.organization_memberships (
    organization_id,
    user_id,
    role,
    is_active
  ) values (
    created_org_id,
    resolved_user_id,
    'system_admin',
    true
  );

  return query select created_org_id, resolved_user_id;
end;
$$;

-- Accept an invitation using only its one-time digest and the authenticated user.
-- The function locks the invitation, verifies email/expiry/status, creates the
-- membership, and marks the invitation accepted in one transaction.
create or replace function public.accept_organization_invitation(
  invitation_token_digest text,
  actor_user_id uuid
)
returns table (organization_id uuid, membership_role public.organization_role)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  invitation public.organization_invitations%rowtype;
  normalized_actor_email text;
begin
  select *
    into invitation
  from public.organization_invitations i
  where i.token_digest = invitation_token_digest
  for update;

  if not found then
    raise exception 'Invitation not found' using errcode = 'P0002';
  end if;

  if invitation.status <> 'pending' then
    raise exception 'Invitation is not pending' using errcode = '22023';
  end if;

  if invitation.expires_at <= timezone('utc', now()) then
    update public.organization_invitations
      set status = 'expired'
      where id = invitation.id;
    raise exception 'Invitation has expired' using errcode = '22023';
  end if;

  select lower(u.email)
    into normalized_actor_email
  from public.app_users u
  where u.id = actor_user_id;

  if normalized_actor_email is null then
    raise exception 'Authenticated application user not found' using errcode = 'P0002';
  end if;

  if normalized_actor_email <> invitation.email then
    raise exception 'Invitation email does not match the authenticated user'
      using errcode = '42501';
  end if;

  insert into public.organization_memberships (
    organization_id,
    user_id,
    role,
    is_active
  ) values (
    invitation.organization_id,
    actor_user_id,
    invitation.role,
    true
  )
  on conflict (organization_id, user_id) do update
    set role = excluded.role,
        is_active = true;

  update public.organization_invitations
    set status = 'accepted',
        accepted_by_user_id = actor_user_id,
        accepted_at = timezone('utc', now())
  where id = invitation.id;

  return query select invitation.organization_id, invitation.role;
end;
$$;

alter table public.organization_invitations enable row level security;

create policy organization_invitations_select_admin
on public.organization_invitations
for select
using (
  public.has_org_role(
    organization_id,
    array['system_admin'::public.organization_role]
  )
);

create policy organization_invitations_insert_admin
on public.organization_invitations
for insert
with check (
  invited_by_user_id = public.current_app_user_id()
  and public.has_org_role(
    organization_id,
    array['system_admin'::public.organization_role]
  )
);

create policy organization_invitations_update_admin
on public.organization_invitations
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

revoke all on function public.bootstrap_organization(text, text, text, text, text, text) from public;
revoke all on function public.accept_organization_invitation(text, uuid) from public;
revoke all on function public.sync_authenticated_user(text, text, text) from public;

comment on table public.organization_invitations is 'Single-use organization membership invitations; only token digests are stored.';
comment on function public.sync_authenticated_user(text, text, text) is 'Trusted identity synchronization after JWT verification by the application server.';
comment on function public.bootstrap_organization(text, text, text, text, text, text) is 'Trusted atomic bootstrap for an organization and its first System Administrator.';
comment on function public.accept_organization_invitation(text, uuid) is 'Trusted atomic invitation acceptance after application authentication.';

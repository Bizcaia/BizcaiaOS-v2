# BizcaiaOS Database and Authorization

The database folder contains ordered PostgreSQL/Supabase-compatible migrations for the isolated BizcaiaOS operational prototype. Apply `001_core_schema.sql`, `002_rbac_rls.sql`, and `003_organization_onboarding.sql` in filename order.

## Schema scope

The core migration defines organizations, application users, organization memberships, acquisition projects, properties, owners, property-owner relationships, negotiations, and immutable negotiation events. Property remains the central operational aggregate, while organizations provide the tenant boundary.

The onboarding migration adds single-use organization invitations, trusted identity synchronization, atomic organization bootstrap, and atomic invitation acceptance. Only invitation-token digests are stored.

## Authentication contract

`002_rbac_rls.sql` resolves the current application user from the verified `request.jwt.claim.sub` claim by matching it to `app_users.auth_subject`. A trusted application server may alternatively issue `SET LOCAL app.user_id = '<uuid>'` after validating a session. An untrusted browser or public database client must never receive credentials that let it select an arbitrary `app.user_id`.

The initial organization and first System Administrator membership must be provisioned through a trusted server or migration role. Subsequent membership changes are protected by RLS and limited to active System Administrators.

## RBAC matrix

| Role | Organization profile | Memberships | Property visibility | Property creation | Property updates | Property deletion |
|---|---|---|---|---|---|---|
| System Administrator | Read and update | Read and manage | All organization properties | Allowed | All fields | Allowed |
| Land Acquisition Manager | Read | Read | All organization properties | Allowed | All fields, including stage and assignments | Denied |
| Supervisor | Read | Read | Assigned properties or properties in a managed project | Denied | Readiness, risk, and operational metadata only | Denied |
| Negotiator | Read | Read | Directly assigned properties only | Denied | Denied on the property record | Denied |
| Legal / Documentation | Read | Read | All organization properties | Denied | Legal and documentation status only | Denied |
| Finance | Read | Read | All organization properties | Denied | Payment status only | Denied |
| Viewer | Read | Read | All organization properties | Denied | Denied | Denied |

Negotiator write authority belongs on negotiation and negotiation-event policies, not on the core property record. Those policies should be introduced with the negotiation API migration so ownership checks and append-only event rules are implemented together.

## Database-enforced safeguards

The RLS policies combine organization membership, role, project responsibility, property assignment, and functional responsibility. Separate triggers prevent cross-tenant project references, reject invalid assignee roles, stop property transfers between organizations, restrict each role to its approved fields, and prevent removal or deactivation of the final active System Administrator.

The `property_operating_view` uses `security_invoker = true`, so dashboard queries inherit the calling user’s underlying property policies rather than the view owner’s privileges. This requires PostgreSQL 15 or a current Supabase PostgreSQL release.

Negotiation history remains append-only. `negotiation_events` rejects updates and deletes, and offers or counteroffers require an amount.

## Validation

Run the static PostgreSQL parser after changing a migration:

```bash
python3 db/validate_sql.py
```

Static parsing verifies PostgreSQL syntax but does not replace integration tests against the target database version. Before production, apply the migrations to a disposable Supabase/PostgreSQL instance and execute the access scenarios in `RBAC_TEST_MATRIX.md` with a non-owner application role so RLS is not bypassed.

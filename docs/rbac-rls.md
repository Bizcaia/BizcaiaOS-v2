# RBAC and Row Level Security

Use this reference before implementing authentication, permissions, assignments, or database policies.

## Authorization model

Role is not complete authorization. Evaluate all relevant dimensions:

| Dimension | Examples |
|---|---|
| Identity | Verified application user or service actor |
| Tenant | Active organization membership |
| Role | Administrator, manager, supervisor, negotiator, legal, finance, viewer |
| Project responsibility | Project manager or project-scoped assignment |
| Property responsibility | Assigned negotiator or assigned manager |
| Functional responsibility | Legal fields, payment fields, document verification |
| Resource ownership | Event author, uploader, task assignee |

Use frontend rules for clarity, server checks for operation semantics, and RLS/triggers for the final database boundary.

## Authentication context

Resolve the database actor from a verified JWT subject mapped to the application user. A trusted server may set a transaction-local user ID after verifying the session. Never expose a credential that lets an untrusted client choose an arbitrary application user ID.

Use `SECURITY DEFINER` only for small policy helpers that require access to protected membership tables. Pin `search_path` to `pg_catalog, public`, avoid dynamic SQL, and keep helper arguments explicit.

## Baseline property policy

| Role | Read scope | Create | Update | Delete |
|---|---|---|---|---|
| System Administrator | Organization | Yes | All fields | Yes |
| Land Acquisition Manager | Organization | Yes | All fields and stage | No by default |
| Supervisor | Assigned or managed project/property | No | Readiness, risk, operational metadata | No |
| Negotiator | Direct assignment | No | Property record: no; negotiation events: assignment-dependent | No |
| Legal / Documentation | Organization | No | Legal and documentation fields | No |
| Finance | Organization | No | Payment fields | No |
| Viewer | Organization | No | No | No |

Adapt the matrix when the brief specifies narrower visibility. Never broaden visibility merely to simplify a query.

## Policy pattern

Use helper functions for readable policy decisions, then use triggers for invariants and field-level restrictions that RLS cannot express cleanly.

A robust property implementation includes:

- A read helper combining role, project responsibility, and property assignment.
- Insert policies for administrators/managers plus a same-organization project check.
- Update policies for authorized roles plus a trigger that compares `OLD` and `NEW` fields.
- Delete policy restricted to the narrowest approved role.
- A trigger rejecting cross-tenant project references and invalid assignees.
- A trigger preventing removal of the final active System Administrator.

## RLS pitfalls

- Table owners and superusers bypass RLS. Test with the actual non-owner application role.
- Views may use owner privileges. Use `security_invoker = true` on supported PostgreSQL versions.
- RLS does not validate that a foreign key belongs to the same tenant. Add composite constraints or triggers.
- A permissive update policy does not restrict which columns changed. Use column grants or an `OLD`/`NEW` comparison trigger.
- Service-role credentials bypass normal user policies. Keep them on trusted servers and restrict their use.
- Membership-management policies need a bootstrap path for the first organization administrator.
- Avoid recursive RLS lookups. Use carefully scoped `SECURITY DEFINER` helpers for membership checks.

## Required denial tests

Test unauthenticated access, cross-tenant reads, inactive membership, unassigned negotiator reads, unauthorized stage changes, unauthorized field changes, cross-tenant project assignment, invalid assignee roles, non-admin membership changes, final-admin removal, non-admin property deletion, and mutation of append-only negotiation events.

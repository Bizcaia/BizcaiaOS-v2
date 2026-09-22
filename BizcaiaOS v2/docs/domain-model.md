# Property-Centered Domain Model

Use this reference when converting a land-acquisition brief into entities, migrations, APIs, and UI views.

## Aggregate boundaries

| Aggregate | Responsibility | Connected records |
|---|---|---|
| Organization | Tenant, settings, membership, and authorization boundary | Users, projects, roles |
| Project | Acquisition program or geographic initiative | Properties, metrics, manager |
| Property | Central operational truth for one parcel or acquisition target | Owners, negotiations, documents, payments, tasks, issues, interactions, timeline |
| Owner | Individual, estate, company, government body, or other legal owner | Property relationships and evidence |
| Negotiation | Current negotiation state for one property | Immutable negotiation events |
| User | Authenticated identity | Memberships, roles, assignments, authorship |

Do not create a separate aggregate solely to group latitude, longitude, and boundary GeoJSON. Keep those fields on Property until GIS behavior has an independent lifecycle, permissions model, or transactional boundary.

## Property identity and tenancy

Every organization-owned aggregate must carry `organization_id`. Property references should be unique within an organization, not globally, unless the business guarantees global uniqueness. A database guard must reject references from a property to a project or assignee in another organization.

Represent ownership with a `property_owners` join table so a property can have multiple owners and an owner can appear on multiple properties. Include ownership percentage, primary-owner indicator, and legal evidence references where appropriate.

## Controlled acquisition lifecycle

Use a database enum or controlled reference table. A practical baseline is:

1. Identified
2. Initial Contact
3. Owner Validation
4. Property Validation
5. Documentation
6. Negotiation
7. Commercial Review
8. Legal Review
9. Agreement Preparation
10. Signing
11. Payment / Closing
12. Acquisition Complete
13. On Hold
14. Withdrawn

Do not accept arbitrary stage strings. Put transition authorization in the server and database. Record manual overrides separately with actor, reason, timestamp, and timeline visibility.

## Negotiation history

Keep `negotiations` as the current state and `negotiation_events` as the historical ledger. Store offers and counteroffers as new event rows with amount, actor, timestamp, and optional note. Prevent update and delete operations on event rows with database triggers.

Allow repeated valid submissions to create distinct events unless the product explicitly adopts idempotency semantics. Do not overwrite prior offers to display the current amount.

## Read models

Build dashboard views from the underlying aggregates rather than duplicating state. A property operating view may expose stage, readiness, risk, assignees, owner count, active negotiation count, and last activity. In PostgreSQL 15+, set RLS-sensitive views to `security_invoker = true` so the caller’s base-table policies remain effective.

## Migration sequence

A safe sequence is:

1. Extensions and controlled types.
2. Organizations, users, memberships, and projects.
3. Owners and properties.
4. Property-owner relationships.
5. Negotiations and immutable events.
6. Indexes and read views.
7. Authentication helpers and RLS.
8. Role/assignment policies and invariant triggers.
9. Supporting aggregates such as documents, tasks, issues, payments, interactions, and audit logs.

Keep each migration forward-only and independently reviewable. Do not place production seed data inside schema migrations.

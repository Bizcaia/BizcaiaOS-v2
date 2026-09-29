# Interactions

An **interaction** records an actual contact or activity involving a property and, optionally, one of its owners: a call, a meeting, a site visit, a message.

Interactions are separate from negotiation events. The difference is meaning, not timing: use a negotiation event for negotiation-specific activity (offers, counteroffers, negotiation meetings) and an interaction for general stakeholder contact, at any acquisition stage. Planned follow-up work belongs in Tasks.

## Record

| Field | Rules |
|---|---|
| Property | Required. The interaction belongs to one property and its organization. |
| Owner | Optional. If given, the owner must be linked to the property when the interaction is recorded. A later unlink does not invalidate the interaction and is not blocked by it. |
| Type | Exactly one of `call`, `meeting`, `site_visit`, `message`, `other`. |
| Notes | Required, up to 4000 characters, and must contain at least one non-whitespace character. |
| Occurred at | Optional. When omitted, the server records its own current UTC time. A supplied value must be a UTC ISO timestamp and must not be later than the server clock — there is no tolerance window. |
| Recorded by | Set by the server to the signed-in user. |

An interaction is immutable once recorded. Archiving is the only change allowed, and an archived interaction cannot be restored. There is no delete.

Recording or archiving an interaction never changes the property's stage or statuses, or any task, negotiation, payment, document, or agreement signature.

## Access

| Role | Record | Read | Archive |
|---|---|---|---|
| System administrator | Yes | Yes | Yes |
| Land acquisition manager | Yes | Yes | Yes |
| Supervisor | Within their managed properties and projects | Same | Same |
| Negotiator | On properties assigned to them | Same | Same |
| Legal / documentation, finance, viewer | No | No | No |

Archiving is not limited to the person who recorded the interaction: any of the roles above may archive an interaction within their scope.

These rules are enforced in PostgreSQL (`database/011_interactions.sql`, row-level security plus a scope trigger) and repeated in the API and the demo adapter.

## API

All routes are under `/api/v1/ops` and require authentication.

| Route | Result |
|---|---|
| `GET /properties/:id/interactions` | Active interactions for the property, newest first. There is no option to include archived interactions. |
| `POST /properties/:id/interactions` | Body: `interactionType`, `notes`, optional `occurredAt`, optional `ownerId`. Returns `201`. |
| `PATCH /interactions/:id` | Body: `{ "archived": true }` only. Archiving twice keeps the first archive time. |

Errors: `400` invalid input, `401` not signed in, `403` a role without interaction access listing or recording on a property it can see, `404` property or interaction not found or not visible (including archiving attempts by a role without interaction access, which cannot see the interaction at all), `422` an owner not linked to the property or a future `occurredAt`.

## Property Timeline

Interactions are the Timeline's seventh source (tie rank 7, kind `interaction`). An entry shows the type, the owner when there is one, when it happened, and who recorded it — for example "Call with Rosa Mendoza" or "Site visit". Notes are never shown in the Timeline. Archived interactions are excluded.

Only the interaction entries are filtered by role: they appear for the four roles above and are absent for legal / documentation, finance, and viewer. Every other Timeline source keeps its existing visibility.

## Demo mode

The demo adapter applies the same validation, archive rules, and Timeline summaries. The demo user is always a system administrator, so role and scope restrictions are demonstrated only in live mode and in the test suites.

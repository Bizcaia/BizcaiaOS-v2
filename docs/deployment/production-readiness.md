# BizcaiaOS deployment readiness: local, staging, production

BizcaiaOS is in the prototype phase. **No staging or production environment
exists yet**, and nothing below claims one does. This guide records the
accepted architecture and the configuration contract, so that moving to
staging and production later means supplying configuration and provisioning
infrastructure (each separately authorized), not redesigning the
application. The same code and the same migration history (`001`–`019`) run
in every environment; only the configuration differs.

## Accepted architecture

| Decision | Choice |
|---|---|
| D-PROD-01 identity | Supabase Auth (email + password; no public sign-up) |
| D-PROD-02 database | Supabase PostgreSQL 17, a **separate project per environment** |
| D-PROD-03 frontend | Render Static Site |
| D-PROD-04 API | Render Web Service |
| D-PROD-05 documents | Render persistent disk; the API stays **single-instance** until C-03 |
| D-PROD-06 domains | staging `staging.<domain>` / `api-staging.<domain>`; production `app.<domain>` / `api.<domain>` |
| D-PROD-07 recovery | Future targets (below); not claimed today |
| D-PROD-13 boundary | Supabase Auth only. The Supabase Data API is not an application data path; the BizcaiaOS API is |

```text
Sign-in:    Browser ── HTTPS ──> Supabase Auth ──> access token (asymmetric JWT)
Data path:  Browser ──> Render Static Site            (static dist/)
            Browser ── Bearer token ──> Render Web Service (BizcaiaOS API, 1 instance)
                                          ├── TLS ──> Supabase PostgreSQL as bizcaiaos_app (RLS)
                                          └────────> Render persistent disk (documents)
```

The frontend never queries Supabase data (no `supabase.from`, `rpc`,
`storage`, `realtime`, or `functions`): it only signs in and hands the access
token to the API, which verifies signature, issuer, audience, `sub`, and
`email` itself (`server/auth.ts`).

## Environment matrix

| Setting | Local | Staging | Production |
|---|---|---|---|
| Supabase project | none, or a developer's own | separate staging project | separate production project |
| Auth | Supabase (optional locally) | Supabase | Supabase |
| Data API | not an application path | **off** | **off** |
| Frontend | `http://localhost:5173` | `https://staging.<domain>` | `https://app.<domain>` |
| API | `http://localhost:8787` | `https://api-staging.<domain>` | `https://api.<domain>` |
| Database | local Docker PostgreSQL | Supabase staging | Supabase production |
| RPO / RTO | not claimed | rehearsal target | D-PROD-07 targets |
| PITR | no | when separately authorized | when separately authorized |

Production and staging share **nothing**: projects, keys, roles, passwords,
Render services, disks, and secrets are all separate.

## Configuration contract

Templates with placeholders only: [`deploy/staging.env.example`](../../deploy/staging.env.example)
and [`deploy/production.env.example`](../../deploy/production.env.example).
Local development uses the root [`.env.example`](../../.env.example).
**Never commit real values**; real values live in the Render dashboard and the
operator's secret store.

### Environment variable matrix

This is the single authoritative list. `<ref>` is the environment's own
Supabase project reference, and `<domain>` is not yet chosen. "Owner" is who
sets the value, and where.

| Variable | Local | Staging | Production | Public / Secret | Build / Runtime | Owner |
|---|---|---|---|---|---|---|
| `NODE_VERSION` | installed Node.js (24 tested) | `24` | `24` | public | build and runtime | Operator: both Render services |
| `VITE_API_BASE_URL` | `http://localhost:8787/api/v1`, or empty for demo mode | `https://api-staging.<domain>/api/v1` | `https://api.<domain>/api/v1` | public | build | Operator: Render Static Site |
| `VITE_SUPABASE_URL` | empty, or a developer's own project | `https://<staging-ref>.supabase.co` | `https://<production-ref>.supabase.co` | public | build | Operator: Static Site, from Supabase |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | empty, or a developer's own key | staging publishable key | production publishable key | public (never a secret or service-role key) | build | Operator: Static Site, from Supabase |
| `VITE_ANALYTICS_ENDPOINT`, `VITE_ANALYTICS_WEBSITE_ID` | optional | optional (both or neither) | optional (both or neither) | public | build | Operator: Static Site |
| `NODE_ENV` | unset | `production` | `production` | public | runtime | Operator: Web Service |
| `PORT` | unset | set by Render (`10000` unless set) | set by Render | public | runtime | Render (automatic) |
| `API_PORT` | `8787` | `10000` (must equal `PORT`) | `10000` (must equal `PORT`) | public | runtime | Operator: Web Service |
| `CORS_ORIGIN` | `http://localhost:5173` | `https://staging.<domain>` | `https://app.<domain>` | public | runtime | Operator: Web Service |
| `DATABASE_URL` | `bizcaiaos_app` at `127.0.0.1` | `bizcaiaos_app.<staging-ref>` on the Supabase pooler | `bizcaiaos_app.<production-ref>` on the Supabase pooler | **secret** | runtime | Operator: Web Service secret |
| `DATABASE_SSL` | empty | `require` | `require` | public | runtime | Operator: Web Service |
| `DATABASE_POOL_SIZE` | optional (default 10) | optional, within the pooler's client limit | optional, within the pooler's client limit | public | runtime | Operator: Web Service |
| `AUTH_ISSUER` | optional (unset: authenticated requests return 503) | `https://<staging-ref>.supabase.co/auth/v1` | `https://<production-ref>.supabase.co/auth/v1` | public | runtime | Operator: Web Service |
| `AUTH_AUDIENCE` | `authenticated` | `authenticated` | `authenticated` | public | runtime | Operator: Web Service |
| `AUTH_JWKS_URL` | `<AUTH_ISSUER>/.well-known/jwks.json` | same rule | same rule | public | runtime | Operator: Web Service |
| `DOCUMENT_STORAGE_PROVIDER` | `local` | `local` | `local` | public | runtime | Operator: Web Service |
| `DOCUMENT_STORAGE_LOCAL_ROOT` | `./.data/documents` | `/var/data/documents` (inside the disk) | `/var/data/documents` (inside the disk) | public | runtime | Operator: Web Service |
| `DOCUMENT_MAX_SIZE_BYTES`, `DOCUMENT_ACCEPTED_MIME_TYPES` | optional (defaults) | optional (defaults) | optional (defaults) | public | runtime | Operator: Web Service |
| `DATABASE_MIGRATE_URL` | local owner role | `bizcaiaos_migrator.<staging-ref>`, port 5432, `sslmode=require` | `bizcaiaos_migrator.<production-ref>`, port 5432, `sslmode=require` | **secret** | migration | Operator: secret store and operator shell only, **never Render** |
| `POSTGRES_APP_USER` | `bizcaiaos_app` | `bizcaiaos_app` | `bizcaiaos_app` | public | migration | Operator shell |
| `POSTGRES_APP_PASSWORD` | local `db:provision-app-role` only | **not used** (password set with `\password`) | **not used** | secret | local tooling | Developer `.env` only |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_PORT` | Docker Compose | not used | not used | local | local tooling | Developer `.env` only |

These names are **not** read by BizcaiaOS, and `staging:preflight` rejects
them:

- `VITE_SUPABASE_ANON_KEY`: the publishable or legacy anon key goes in
  `VITE_SUPABASE_PUBLISHABLE_KEY`;
- `DOCUMENT_ROOT`: use `DOCUMENT_STORAGE_LOCAL_ROOT`;
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `JWKS_URL`.

Supabase project settings that are not environment variables (Auth Site URL,
redirect URLs, sign-up, signing keys, Data API) are listed in
[staging-provisioning.md](staging-provisioning.md#b-supabase-staging-project-g1-g2).

Rules the code depends on:

- Anything named `VITE_*` is embedded in the public browser bundle. A secret
  (database URL, secret or service-role key, password) must never use a
  `VITE_` name.
- The API reads `API_PORT`, not `PORT`; set `API_PORT` to the port Render
  routes to (`10000` by default).
- The API and the migration runner fill unset variables from a `.env` file in
  the working directory. Deployed and operator environments must have **no
  `.env` file**.
- The migration runner ignores `DATABASE_SSL`: put `sslmode=require` in
  `DATABASE_MIGRATE_URL`.
- Both connections verify the server certificate against Node's trusted
  roots. The current `pg` driver treats `sslmode=require` as `verify-full`,
  and an `sslmode` in `DATABASE_URL` overrides `DATABASE_SSL`. If Supabase's
  certificate is not trusted, add `sslrootcert=<CA file>` to both URLs; never
  disable verification.

### Checking a configuration

`npm run config:check` validates an environment against this contract
without contacting anything and without printing any value:

```bash
npm run config:check -- --target staging --scope frontend
npm run config:check -- --target staging --scope api
npm run config:check -- --target production --scope migration
```

It rejects, among other things: missing required values, non-https URLs,
hosts that break the D-PROD-06 layout (for example a staging build pointing
at `api.<domain>`), a frontend and API wired to different Supabase projects,
a secret in a `VITE_` variable or a secret/service-role publishable key,
`CORS_ORIGIN` that is not a single exact origin, an API connecting as
anything other than `bizcaiaos_app`, migration credentials on the API
service, and a migration connection on the transaction pooler (6543),
without `sslmode=require`, or as anyone other than `bizcaiaos_migrator`. Run
it on Linux, macOS, or PowerShell; Git Bash on Windows rewrites values such
as `/var/data/documents` into Windows paths.

## Sign-in origins and redirects

Password sign-in needs no OAuth callback, but each Supabase project's Site
URL and redirect allowlist must name its own frontend origin, and the API's
`CORS_ORIGIN` must match it exactly.

| Environment | Supabase Site URL / redirect allowlist | `CORS_ORIGIN` | `VITE_API_BASE_URL` |
|---|---|---|---|
| Local | `http://localhost:5173` (developer project only) | `http://localhost:5173` | `http://localhost:8787/api/v1` |
| Staging | `https://staging.<domain>` | `https://staging.<domain>` | `https://api-staging.<domain>/api/v1` |
| Production | `https://app.<domain>` | `https://app.<domain>` | `https://api.<domain>/api/v1` |

`<domain>` is not yet chosen. When it is, set it in: Render custom domains
(both services), DNS, the Supabase Site URL and redirect allowlist,
`CORS_ORIGIN`, and `VITE_API_BASE_URL` (which requires a frontend rebuild).

## Database roles

| Role | Purpose | Attributes |
|---|---|---|
| `bizcaiaos_migrator` | Migration owner: runs `npm run db:migrate`, owns every BizcaiaOS object | `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`; `CREATE, USAGE` on schema `public` |
| `bizcaiaos_app` | API runtime role; subject to RLS | `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`; owns nothing |

Create both per project as `postgres` from the operator's `psql` session.
The operator chooses the passwords and stores them only in Render or the
secret store (never in Git, chat, or this repository). `\password` sends a
hash, so the password stays out of SQL history:

```sql
create role bizcaiaos_migrator login nosuperuser nocreatedb nocreaterole nobypassrls;
grant create, usage on schema public to bizcaiaos_migrator;
create role bizcaiaos_app login nosuperuser nocreatedb nocreaterole nobypassrls;
\password bizcaiaos_migrator
\password bizcaiaos_app
```

`db:migrate` never creates or re-passwords `bizcaiaos_app` (C-02); it checks
the roles in a read-only preflight and grants the application role what it
needs. Migration 019 removes `PUBLIC` execute from BizcaiaOS functions and,
where they exist, every `anon`/`authenticated` privilege in `public`; because
its default-privilege change applies to the role that runs it, migrations
must always run as `bizcaiaos_migrator`.

## Migration promotion

```text
LOCAL VALIDATION (PostgreSQL 16 and 17, full integration suite)
      ↓
STAGING MIGRATION (operator, bizcaiaos_migrator, after a backup)
      ↓
STAGING VALIDATION (privilege checks, smoke tests, recovery rehearsal)
      ↓
PRODUCTION MIGRATION (separately authorized, maintenance window, after a verified backup)
```

Each environment runs the same command twice: the first run applies every
pending migration, the second must apply none.

After the first staging migration, verify the following. The
[staging runbook](staging-provisioning.md) gives the exact steps, and
`deploy/sql/` holds read-only SQL for each check:

1. `select current_user` on `DATABASE_MIGRATE_URL` is `bizcaiaos_migrator`.
2. `schema_migrations` holds `001`–`019`, `019` exactly once.
3. `PUBLIC` cannot execute any non-extension function in `public`;
   `bizcaiaos_app` can execute all of them.
4. `anon` and `authenticated` hold no table (including `schema_migrations`),
   sequence, or function privileges in `public`.
5. `pg_default_acl`: record every entry (role, schema, type, privileges); the
   migrator's global entry has no `PUBLIC` execute; note any `postgres` or
   `supabase_admin` defaults that still grant to `anon`/`authenticated`.
6. Future functions: `pg_default_acl` shows that the migrator's global
   function default grants no `PUBLIC` execute and its `public` default
   grants `bizcaiaos_app` execute. This is read from the catalog; nothing is
   created on staging.
7. List non-extension functions in `public` not owned by the migrator; do not
   modify provider-owned objects.
8. RLS is enabled on all 18 tables with all 49 policies present.
9. The Data API is off and returns no endpoints.

## Render

**Static Site (frontend)**: build `npm ci && npm run build`, publish
directory `dist`, environment: `NODE_VERSION`, `VITE_API_BASE_URL`,
`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`. No rewrite rules are
needed (the app navigates with `#app`). Custom domain `staging.<domain>` or
`app.<domain>`.

**Web Service (API)**: build `npm ci --include=dev` (`tsx` is a dev
dependency, and `NODE_ENV=production` would otherwise skip it), start
`npm run start:api`, health check path `/health` (returns `{"status":"ok"}`
after a database round trip; it exposes nothing else). One instance, a paid
plan, and a persistent disk mounted at `/var/data` with
`DOCUMENT_STORAGE_LOCAL_ROOT=/var/data/documents` (the default
`./.data/documents` is not on the disk and is lost on redeploy). Expect a
brief outage on each deploy (disk-backed services cannot overlap instances),
and do not run migrations automatically on deploy: migrations are an operator
step. Custom domain `api-staging.<domain>` or `api.<domain>`.

## Recovery readiness (D-PROD-07, future targets)

| | RPO | RTO | Retention |
|---|---|---|---|
| Database | ≤ 2 minutes (Supabase PITR) | ≤ 4 hours | 14 days |
| Documents | ≤ 24 hours (Render daily disk snapshot) | ≤ 4 hours | ≥ 7 days (Render) |

These are **targets, not current capabilities**. They require Supabase Pro,
at least Small compute, and the 14-day PITR add-on, all separately
authorized. Known limitations:

- Neither provider publishes restore durations: the RTO must be **measured**
  in a staging rehearsal before it can be claimed.
- Database and document retention differ (14 days vs at least 7), and a
  database restored with PITR can be newer than the restored documents; rows
  may then reference missing files (accepted until C-03/off-host document
  backups).
- Render documents no on-demand snapshot, so a pre-migration document backup
  is not guaranteed.
- An in-place Supabase restore keeps the project and its keys. Restoring to a
  **new** project changes its URL and signing keys: `AUTH_*` and
  `VITE_SUPABASE_*` must then be updated (frontend rebuilt), and Auth
  settings and keys are not copied.
- Staging must rehearse the same procedure: marker write, chosen restore
  point, restore start and end, API and `/api/v1/me` recovery, all with UTC
  timestamps; for documents, a marker file's SHA-256 and a database-to-file
  consistency check.

## Provisioning checklist (each step separately authorized)

Staging follows [staging-provisioning.md](staging-provisioning.md) (gates,
exact settings, migration and verification steps, recovery rehearsal),
recorded in
[staging-verification-checklist.md](staging-verification-checklist.md). It is
gated by `npm run staging:preflight`. The owner's inputs are listed in
[staging-owner-input.md](staging-owner-input.md). The summary below covers
both environments.

**Supabase** (per environment): organization billing plan · project creation
(region; staging and production in the same region) · compute · PITR and
retention · Auth: email/password on, public sign-ups off, anonymous and phone
off, asymmetric JWT signing keys, Site URL and redirect allowlist · Data API
off · roles `bizcaiaos_migrator` and `bizcaiaos_app` · migration connection ·
`npm run config:check -- --scope migration` · migrations `001`–`019` twice ·
the verification list above · sign-in smoke test.

**Render** (per environment): Static Site · Web Service (one instance, paid
plan) · persistent disk · environment variables and secrets ·
`npm run config:check` for both scopes · `API_PORT` · health check `/health`
· `CORS_ORIGIN` · deploy · logs · custom domains.

**DNS**: `staging.<domain>`, `api-staging.<domain>`, `app.<domain>`,
`api.<domain>`, with TLS.

**Smoke tests** (staging first): sign-in and session · `/api/v1/me` · token
rejection (wrong issuer, wrong audience, tampered) · organization isolation
(a second organization cannot reach the first) · sign-out · no Supabase data,
RPC, storage, realtime, or functions calls from the browser · no database
credentials in the browser. Mutating lifecycle, document, and payment tests
and the recovery rehearsal are separate authorizations.

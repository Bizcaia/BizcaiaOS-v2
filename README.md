# BizcaiaOS

Reconstructed from the Manus.ai export and prepared as the working application baseline.

## Current state
- Public marketing site retained.
- Preview operations workspace added under `#app`.
- Organization/team management retained.
- Project and property API foundation added.
- Property pipeline, search, creation, stage/readiness updates, and dashboard metrics added.
- PostgreSQL migrations retained as the security/data foundation.

## Local development

### 1. Prerequisites
- Node.js 20+
- Docker and Docker Compose
- Copy `.env.example` to `.env` and replace the password placeholders. Do not commit `.env`.

### 2. Start PostgreSQL
```bash
npm run db:up
```
This starts Postgres 16 on `POSTGRES_PORT` (default 5432) with a persistent Docker volume. Database name: `POSTGRES_DB` (default `bizcaiaos`). Owner/migrate user: `POSTGRES_USER` (default `bizcaiaos_owner`). Application user: `POSTGRES_APP_USER` (default `bizcaiaos_app`).

### 3. Configure `.env`
`DATABASE_URL` must use the **application** role (`bizcaiaos_app`). That role is not the table owner and does not have `BYPASSRLS`.

`DATABASE_MIGRATE_URL` must use the **owner/migrate** role. Migrations run as that role.

### 4. Create the application role and run migrations
```bash
npm run db:provision-app-role
npm run db:migrate
```
`db:provision-app-role` is for local databases only. It creates `POSTGRES_APP_USER` with `POSTGRES_APP_PASSWORD` when the role does not exist, and never alters an existing role. In other environments the database operator creates and manages the application role.

`db:migrate` applies the numbered files in `database/` in order, records them in `public.schema_migrations`, and grants table/function privileges to the application role. It never creates the application role or changes its password, so it needs only `DATABASE_MIGRATE_URL` (and `POSTGRES_APP_USER` when the role is not `bizcaiaos_app`). Before writing anything it runs a read-only preflight and stops if the application role is missing, cannot log in, has SUPERUSER or BYPASSRLS, or owns tables; if the migration role cannot create in `public` or does not own the existing tables; or if `schema_migrations` is not a prefix of the registered list.

Re-running the command is safe. Failure stops the process and does not record the failed file.

Apply these migrations, including `004_property_workflow_rls.sql`, before using owner create/link against a database.

### 5. Start backend and frontend
```bash
npm install
npm run dev:api
npm run dev
```

### 6. Unit tests (mocked database)
```bash
npm test
```

### 7. Integration tests (real PostgreSQL)
```bash
npm run test:integration
```
Requires Docker Postgres up and migrated. These tests are excluded from `npm test`.

### 8. Stop or reset the local database
```bash
npm run db:down
npm run db:reset
```
`db:reset` destroys the Docker volume, starts a new cluster, creates the application role, and re-runs migrations.

## Run from the repository root

```bash
npm install
npm run dev
npm run dev:api
```

Copy `.env.example` to `.env` and fill in local values. Do not commit `.env`.

| Command | Purpose |
|---|---|
| `npm run dev` | Vite UI (default http://localhost:5173) |
| `npm run dev:api` | Express API (default http://localhost:8787) |
| `npm run db:up` | Start local PostgreSQL |
| `npm run db:provision-app-role` | Create the local application role if missing (local only) |
| `npm run db:migrate` | Apply numbered SQL migrations |
| `npm run db:reset` | Wipe local volume and re-migrate |
| `npm run config:check` | Check a deployment environment against the configuration contract |
| `npm run db:down` | Stop local PostgreSQL |
| `npm run build` | Production UI build |
| `npm run typecheck` | Client TypeScript |
| `npm run typecheck:api` | Server TypeScript |
| `npm run test:frontend` | Frontend Vitest suite |
| `npm run test:api` | Mocked API tests (`server/*.test.ts`, excluding integration) |
| `npm run test:integration` | Real PostgreSQL RLS and API tests |
| `npm test` | Frontend tests, then mocked API tests |

## Demo mode vs live API

Leave `VITE_API_BASE_URL` empty to use the in-memory preview adapters and the demo organization.

Set `VITE_API_BASE_URL` to include the `/api/v1` prefix, for example:

```
VITE_API_BASE_URL=http://localhost:8787/api/v1
```

- Organization requests: `/api/v1/me`, `/api/v1/organizations/...`
- Operations requests: `/api/v1/ops/projects`, `/api/v1/ops/properties`, `/api/v1/ops/dashboard`

Live mode loads the authenticated user's first active organization from `/api/v1/me`. It never uses the demo organization UUID. If the user has no organization, the existing onboarding flow is shown.

### Sign-in (Supabase Auth)

Live mode signs users in with Supabase Auth using email and password. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (public values only) and the server's `AUTH_*` values for the same Supabase project:

```
AUTH_ISSUER=https://<project-ref>.supabase.co/auth/v1
AUTH_AUDIENCE=authenticated
AUTH_JWKS_URL=https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json
```

The Supabase project must use asymmetric JWT signing keys; the API cannot verify legacy HS256 tokens. Users must sign in with an email address, because the API requires a non-empty `email` claim.

There is no public sign-up in the app: accounts are created by an administrator, and public sign-ups should be disabled in the Supabase Auth settings. After sign-in, the app passes the Supabase access token to the API through `window.__BIZCAIAOS_AUTH__`; the frontend never reads data from Supabase directly.

Without the two `VITE_SUPABASE_*` values, live mode has no sign-in and API calls fail with "Authentication provider is not connected". Staging and production Supabase values are supplied separately at deployment.

## Environment variables

See `.env.example`.

Frontend: `VITE_API_BASE_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_ANALYTICS_ENDPOINT`, `VITE_ANALYTICS_WEBSITE_ID`

API: `API_PORT`, `CORS_ORIGIN`, `DATABASE_URL`, `DATABASE_MIGRATE_URL`, `DATABASE_POOL_SIZE`, `DATABASE_SSL`, `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `POSTGRES_*`

Analytics is optional. The Umami script is injected only when both `VITE_ANALYTICS_ENDPOINT` and `VITE_ANALYTICS_WEBSITE_ID` are set. An empty or missing pair is omitted from the production build.

Apply the numbered SQL files in `database/` in order with `npm run db:migrate`, the recorded runner. Do not connect the API as the table owner if you want RLS to apply.

## Staging and production

No staging or production environment exists yet. [docs/deployment/production-readiness.md](docs/deployment/production-readiness.md) records the accepted architecture (Supabase Auth and PostgreSQL, Render Static Site and Web Service), the per-environment configuration contract, database roles, migration promotion, recovery targets, and the provisioning checklist. Placeholder templates live in `deploy/staging.env.example` and `deploy/production.env.example`; never commit real values. Check an environment before deploying with `npm run config:check -- --target staging --scope frontend` (or `--scope api`, `--scope migration`); it contacts nothing and prints no values.

The dashboard “Active negotiations” metric continues to count properties whose `acquisition_stage = negotiation`, not open/paused rows in `negotiations`.

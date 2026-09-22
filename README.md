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

### 4. Run migrations
```bash
npm run db:migrate
```
Applies `database/001` through `database/005` in order, records them in `public.schema_migrations`, creates the application role, and grants table/function privileges.

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
`db:reset` destroys the Docker volume, starts a new cluster, and re-runs migrations.

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
| `npm run db:migrate` | Apply numbered SQL migrations |
| `npm run db:reset` | Wipe local volume and re-migrate |
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

Live mode still requires a JWT access token from `window.__BIZCAIAOS_AUTH__` and server JWKS settings. No identity provider is wired in this baseline.

## Environment variables

See `.env.example`.

Frontend: `VITE_API_BASE_URL`, `VITE_ANALYTICS_ENDPOINT`, `VITE_ANALYTICS_WEBSITE_ID`

API: `API_PORT`, `CORS_ORIGIN`, `DATABASE_URL`, `DATABASE_MIGRATE_URL`, `DATABASE_POOL_SIZE`, `DATABASE_SSL`, `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `POSTGRES_*`

Analytics is optional. The Umami script is injected only when both `VITE_ANALYTICS_ENDPOINT` and `VITE_ANALYTICS_WEBSITE_ID` are set. An empty or missing pair is omitted from the production build.

Apply SQL in order: `database/001_core_schema.sql`, `002_rbac_rls.sql`, `003_organization_onboarding.sql`, `004_property_workflow_rls.sql`, `005_projects_write_rls.sql`. Use `npm run db:migrate` for the recorded runner. Do not connect the API as the table owner if you want RLS to apply.

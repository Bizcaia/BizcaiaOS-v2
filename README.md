# BizcaiaOS

Reconstructed from the Manus.ai export and prepared as the working application baseline.

## Current state
- Public marketing site retained.
- Preview operations workspace added under `#app`.
- Organization/team management retained.
- Project and property API foundation added.
- Property pipeline, search, creation, stage/readiness updates, and dashboard metrics added.
- PostgreSQL migrations retained as the security/data foundation.

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
| `npm run build` | Production UI build |
| `npm run typecheck` | Client TypeScript |
| `npm run typecheck:api` | Server TypeScript |
| `npm run test:frontend` | Frontend Vitest suite |
| `npm test` | Frontend tests, then API tests (`server/*.test.ts`) |

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

API: `API_PORT`, `CORS_ORIGIN`, `DATABASE_URL`, `DATABASE_POOL_SIZE`, `DATABASE_SSL`, `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`

Analytics is optional. The Umami script is injected only when both `VITE_ANALYTICS_ENDPOINT` and `VITE_ANALYTICS_WEBSITE_ID` are set. An empty or missing pair is omitted from the production build.

Apply SQL in order: `database/001_core_schema.sql`, `002_rbac_rls.sql`, `003_organization_onboarding.sql`.

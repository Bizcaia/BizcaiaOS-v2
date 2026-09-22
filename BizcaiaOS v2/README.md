# BizcaiaOS

Reconstructed from the Manus.ai export and prepared as the working application baseline.

## Current state
- Public marketing site retained.
- Preview operations workspace added under `#app`.
- Organization/team management retained.
- Project and property API foundation added.
- Property pipeline, search, creation, stage/readiness updates, and dashboard metrics added.
- PostgreSQL migrations retained as the security/data foundation.

## Run

Install dependencies, then:

```bash
npm run dev
npm run dev:api
```

Live API mode requires `VITE_API_BASE_URL`, `DATABASE_URL`, `AUTH_JWKS_URL`, `AUTH_ISSUER`, and `AUTH_AUDIENCE`.

Without `VITE_API_BASE_URL`, the UI uses its local preview adapter.

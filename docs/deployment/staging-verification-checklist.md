# Staging verification checklist

> **Status: nothing verified. Staging is NOT PROVISIONED.** Tick a box only
> with evidence from the staging environment itself: a command output, a
> dashboard screenshot, or a timestamped observation recorded in the staging
> record. Documentation, templates, or local results never tick a box.

Copy this file into the staging record and fill in the copy; keep the
repository version blank. Step numbers refer to
[staging-provisioning.md](staging-provisioning.md).

Operator: ______  Date (UTC): ______  Commit SHA: ______

## Infrastructure identity

- [ ] Correct Supabase organization (B1). Evidence: ______
- [ ] Correct staging project; ref recorded (B1, step 1). Evidence: ______
- [ ] Correct region: `ap-southeast-1` (B1). Evidence: ______
- [ ] Production project is different (ref differs; preflight `--production-ref`). Evidence: ______
- [ ] Correct Render services: Static Site and Web Service named for staging (D). Evidence: ______
- [ ] Correct staging domain: `staging.<domain>` and `api-staging.<domain>` (E). Evidence: ______

## Supabase

- [ ] Pro plan (G1). Evidence: ______
- [ ] Required compute: Small or larger (G1). Evidence: ______
- [ ] PITR configured (G1). Evidence: ______
- [ ] Retention confirmed: 14 days. Evidence: ______
- [ ] Data API OFF: setting, and the `/rest/v1/` status code (step 5). Evidence: ______
- [ ] Auth enabled; email provider on (B2). Evidence: ______
- [ ] Public sign-up OFF; sign-up probe refused (step 6). Evidence: ______
- [ ] Anonymous and phone sign-in OFF (B2). Evidence: ______
- [ ] Asymmetric JWT signing; JWKS has no `oct` key (step 6). Evidence: ______
- [ ] Site URL correct: `https://staging.<domain>` (B2). Evidence: ______
- [ ] Redirect URLs correct: exactly `https://staging.<domain>` (B2). Evidence: ______

## Database

- [ ] `bizcaiaos_migrator` exists (PRE-2). Evidence: ______
- [ ] `bizcaiaos_app` exists (PRE-2). Evidence: ______
- [ ] Role attributes verified: no superuser, createrole, createdb, or bypassrls (PRE-2, APP-1). Evidence: ______
- [ ] SSL verified: SSL enforcement on; both connections verify the certificate (B5, step 2). Evidence: ______
- [ ] App connection uses `bizcaiaos_app` (APP-1; preflight). Evidence: ______
- [ ] Migration connection uses `bizcaiaos_migrator` (PRE-1, POST-1). Evidence: ______
- [ ] Migration connection does NOT use transaction pooler port 6543 (preflight). Evidence: ______

## Migration 019

- [ ] `001`–`019` applied, `019` exactly once (steps 7 to 8, POST-2). Evidence: ______
- [ ] Second run applies 0 (steps 9 to 10). Evidence: ______
- [ ] `PUBLIC` execute revoked (POST-4). Evidence: ______
- [ ] `anon` privileges verified (POST-5). Evidence: ______
- [ ] `authenticated` privileges verified (POST-5). Evidence: ______
- [ ] `bizcaiaos_app` verified (POST-6, APP-1 to APP-3). Evidence: ______
- [ ] Trusted identity functions verified (POST-7). Evidence: ______
- [ ] Future-function default privileges verified (POST-8). Evidence: ______
- [ ] RLS: 18 tables, 49 policies (POST-9). Evidence: ______
- [ ] Full integration suite passed on disposable PostgreSQL 17 at this commit (step 17). Evidence: ______

## Application

- [ ] Render API healthy: one instance, disk attached (D). Evidence: ______
- [ ] `/health` returns `{"status":"ok"}` (step 18). Evidence: ______
- [ ] Frontend loads at `https://staging.<domain>` (step 18). Evidence: ______
- [ ] Frontend points to the staging API (network panel) (step 18). Evidence: ______
- [ ] API points to staging Supabase (`AUTH_ISSUER` ref = staging ref) (preflight). Evidence: ______
- [ ] Frontend and API use the same Supabase project (preflight). Evidence: ______
- [ ] CORS exact: only `https://staging.<domain>` (step 18). Evidence: ______
- [ ] Auth login works (step 19). Evidence: ______
- [ ] Authenticated API request works: `/api/v1/me` 200 (step 19). Evidence: ______
- [ ] Invalid tokens refused without data (step 19). Evidence: ______
- [ ] RLS works: a second organization cannot reach the first (G6 write-path test). Evidence: ______
- [ ] Document storage path works: upload and download under `/var/data/documents` (G6). Evidence: ______

## Recovery

- [ ] PITR target confirmed: RPO ≤ 2 minutes (G1). Evidence: ______
- [ ] Backup retention recorded: 14 days. Evidence: ______
- [ ] Render disk snapshot policy recorded (F). Evidence: ______
- [ ] Staging restore rehearsal scheduled (G6). Evidence: ______
- [ ] Actual restore duration measured: database and documents (F). Evidence: ______
- [ ] 4-hour RTO target assessed against the measurement (F). Evidence: ______

# Staging verification checklist

> **Status: nothing verified. Staging is NOT PROVISIONED.** Every row below is
> `NOT_VERIFIED` in the repository, and stays so until the evidence comes from
> the real staging environment itself. Acceptable evidence: a command output,
> a dashboard screenshot, or a timestamped observation in the staging record.
> Code, documentation, templates, offline runs, and disposable/local PostgreSQL
> results are never staging evidence.

Each row takes exactly one state:

| State | Use when |
|---|---|
| `VERIFIED` | the check was performed **on the real staging environment** and the evidence is recorded |
| `NOT_VERIFIED` | not yet performed, performed without recorded evidence, or the evidence came from anywhere other than real staging |
| `NOT_APPLICABLE` | the check does not apply, with the reason recorded (for example, PITR was not authorized at G1) |

A `FAIL` is a stop: record it, leave the row `NOT_VERIFIED`, and ask the
owner how to proceed (runbook, section "Execution order").

Copy this file into the staging record and fill in the copy; keep the
repository version as it is. For production, use a separate copy with the
production values (`app.<domain>`, `api.<domain>`, the production project);
the same three states and the same evidence rule apply. Step numbers refer to
[staging-provisioning.md](staging-provisioning.md).

Operator: ______  Date (UTC): ______  Commit SHA: ______  Environment: staging

## Infrastructure identity

| Check | State | Evidence |
|---|---|---|
| Correct Supabase organization (B1) | NOT_VERIFIED | ______ |
| Correct staging project; ref recorded (B1, step 1) | NOT_VERIFIED | ______ |
| Correct region: `ap-southeast-1` (B1) | NOT_VERIFIED | ______ |
| Production project is different (ref differs; preflight `--production-ref`) | NOT_VERIFIED | ______ |
| Correct Render services: Static Site and Web Service named for staging (D) | NOT_VERIFIED | ______ |
| Correct staging domain: `staging.<domain>` and `api-staging.<domain>` (E) | NOT_VERIFIED | ______ |

## Supabase

| Check | State | Evidence |
|---|---|---|
| Pro plan (G1) | NOT_VERIFIED | ______ |
| Required compute: Small or larger (G1) | NOT_VERIFIED | ______ |
| PITR configured (G1) | NOT_VERIFIED | ______ |
| Retention confirmed: 14 days | NOT_VERIFIED | ______ |
| Data API OFF: setting, and the `/rest/v1/` status code (step 5) | NOT_VERIFIED | ______ |
| Auth enabled; email provider on (B2) | NOT_VERIFIED | ______ |
| Public sign-up OFF; sign-up probe refused (step 6) | NOT_VERIFIED | ______ |
| Anonymous and phone sign-in OFF (B2) | NOT_VERIFIED | ______ |
| Asymmetric JWT signing; JWKS has no `oct` key (step 6) | NOT_VERIFIED | ______ |
| Site URL correct: `https://staging.<domain>` (B2) | NOT_VERIFIED | ______ |
| Redirect URLs correct: exactly `https://staging.<domain>` (B2) | NOT_VERIFIED | ______ |

## Database

| Check | State | Evidence |
|---|---|---|
| `bizcaiaos_migrator` exists (PRE-2) | NOT_VERIFIED | ______ |
| `bizcaiaos_app` exists (PRE-2) | NOT_VERIFIED | ______ |
| Role attributes verified: no superuser, createrole, createdb, or bypassrls (PRE-2, APP-1) | NOT_VERIFIED | ______ |
| SSL verified: SSL enforcement on; both connections verify the certificate (B5, step 2) | NOT_VERIFIED | ______ |
| App connection uses `bizcaiaos_app` (APP-1; preflight) | NOT_VERIFIED | ______ |
| Migration connection uses `bizcaiaos_migrator` (PRE-1, POST-1) | NOT_VERIFIED | ______ |
| Migration connection does NOT use transaction pooler port 6543 (preflight) | NOT_VERIFIED | ______ |

## Migration 019

| Check | State | Evidence |
|---|---|---|
| `001`–`019` applied, `019` exactly once (steps 7 to 8, POST-2) | NOT_VERIFIED | ______ |
| Second run applies 0 (steps 9 to 10) | NOT_VERIFIED | ______ |
| `PUBLIC` execute revoked (POST-4) | NOT_VERIFIED | ______ |
| `anon` privileges verified (POST-5) | NOT_VERIFIED | ______ |
| `authenticated` privileges verified (POST-5) | NOT_VERIFIED | ______ |
| `bizcaiaos_app` verified (POST-6, APP-1 to APP-3) | NOT_VERIFIED | ______ |
| Trusted identity functions verified (POST-7) | NOT_VERIFIED | ______ |
| Future-function default privileges verified (POST-8) | NOT_VERIFIED | ______ |
| RLS: 18 tables, 49 policies (POST-9) | NOT_VERIFIED | ______ |
| Full integration suite passed on disposable PostgreSQL 17 at this commit (step 17; disposable by design, never run against staging: record the run, it is not staging evidence of anything else) | NOT_VERIFIED | ______ |
| R1 verifier, offline, before provisioning: repository and configuration `VERIFIED` (gate A4; offline by design: it verifies the repository and the supplied file only) | NOT_VERIFIED | ______ |
| R1 verifier on staging with `--database --strict`: exit 0 (`RESULT: NO_FINDINGS`), only the two provider checks `NOT_VERIFIED` (step 11) | NOT_VERIFIED | ______ |

## Application

| Check | State | Evidence |
|---|---|---|
| Render API healthy: one instance, disk attached (D) | NOT_VERIFIED | ______ |
| `/health` returns `{"status":"ok"}` (step 18) | NOT_VERIFIED | ______ |
| Frontend loads at `https://staging.<domain>` (step 18) | NOT_VERIFIED | ______ |
| Frontend points to the staging API (network panel) (step 18) | NOT_VERIFIED | ______ |
| API points to staging Supabase (`AUTH_ISSUER` ref = staging ref) (preflight) | NOT_VERIFIED | ______ |
| Frontend and API use the same Supabase project (preflight) | NOT_VERIFIED | ______ |
| CORS exact: only `https://staging.<domain>` (step 18) | NOT_VERIFIED | ______ |
| Auth login works (step 19) | NOT_VERIFIED | ______ |
| Authenticated API request works: `/api/v1/me` 200 (step 19) | NOT_VERIFIED | ______ |
| Invalid tokens refused without data (step 19) | NOT_VERIFIED | ______ |
| RLS works: a second organization cannot reach the first (G6 write-path test) | NOT_VERIFIED | ______ |
| Document storage path works: upload and download under `/var/data/documents` (G6) | NOT_VERIFIED | ______ |

## Recovery

| Check | State | Evidence |
|---|---|---|
| PITR target confirmed: RPO ≤ 2 minutes (G1) | NOT_VERIFIED | ______ |
| Backup retention recorded: 14 days | NOT_VERIFIED | ______ |
| Render disk snapshot policy recorded (F) | NOT_VERIFIED | ______ |
| Staging restore rehearsal scheduled (G6) | NOT_VERIFIED | ______ |
| Actual restore duration measured: database and documents (F) | NOT_VERIFIED | ______ |
| 4-hour RTO target assessed against the measurement (F) | NOT_VERIFIED | ______ |

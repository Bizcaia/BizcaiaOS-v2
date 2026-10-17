# BizcaiaOS-v2 — agent operating contract

Neutral continuity brief for any AI coding agent (Cursor, Claude Code, or similar).  
**Authoritative current-state facts:** [`docs/deployment/CURRENT_STATE.md`](docs/deployment/CURRENT_STATE.md).

## Reviewed baseline

| Field | Value |
|---|---|
| Git baseline (pin) | `f25b7a749e41037cafb8e03da88f25b93da108ba` |
| Staging org / project | `bizcaiaos-staging` / `bizcaiaos-staging` |
| Staging ref / region | `lktdoyjzpremctpvcdco` / `ap-southeast-1` |
| G3 | **CLOSED / ACCEPTED WITH DOCUMENTED RESIDUALS** |

## Do

- Prefer this pin and `CURRENT_STATE.md` over stale “NOT PROVISIONED” / “G3 NOT AUTHORIZED” banners in historical runbooks.
- Treat historical procedure text in `docs/deployment/staging-*.md` as the **procedure design**, not live gate status.
- Keep secrets, passwords, auth stamps, raw staging evidence, launcher output, and staging config **out of Git**.

## Do not

- **Do not reopen G3** (no further G3 runtime, remediation of accepted residuals, or re-migration of `001`–`020` on this staging project without a new explicit owner authorization that names that work).
- **Do not** treat G3 closeout as authorization for **G4, G5, G6, hosting, DNS, or production**.
- **Do not** relabel accepted residuals as VERIFIED: **F10**, **F12**, R1 provider `NOT_VERIFIED` (`required=false`), **R-F7**.
- **Do not** invent verification that is not already recorded in `CURRENT_STATE.md` or owner-authorized evidence.
- **Do not** contact or mutate staging, Auth/provider settings, roles, or production unless separately and explicitly authorized.

## Where to look

| Need | Location |
|---|---|
| Live gate / residual disposition | [`docs/deployment/CURRENT_STATE.md`](docs/deployment/CURRENT_STATE.md) |
| Architecture + env contract | [`docs/deployment/production-readiness.md`](docs/deployment/production-readiness.md) |
| Staging procedure (historical wording preserved) | [`docs/deployment/staging-provisioning.md`](docs/deployment/staging-provisioning.md) |
| Product / local app workflow | [`README.md`](README.md) |

Raw G3 evidence and launchers (if present on the operator machine) live **outside** this repository and must not be committed.

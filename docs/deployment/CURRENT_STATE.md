# BizcaiaOS — current deployment / gate state

**Authoritative overlay** for live disposition.  
Historical runbooks and checklists below may still contain preparation-time language (`NOT PROVISIONED`, `NOT AUTHORIZED`). **Prefer this file** for what is true now. Do not rewrite those documents’ procedure bodies to invent a different history.

Related: [`AGENTS.md`](../../AGENTS.md) (multi-agent operating contract).

---

## Reviewed baseline

| Field | Value |
|---|---|
| Pin (reviewed Git tip for this closeout) | `f25b7a749e41037cafb8e03da88f25b93da108ba` |
| Staging organization | `bizcaiaos-staging` |
| Staging project | `bizcaiaos-staging` |
| Staging ref | `lktdoyjzpremctpvcdco` |
| Staging region | `ap-southeast-1` |

---

## Gate disposition (live)

| Gate | Live disposition |
|---|---|
| **G3** | **CLOSED / ACCEPTED WITH DOCUMENTED RESIDUALS** — do **not** reopen |
| G4 (Render staging services) | **NOT AUTHORIZED** — separate explicit owner authorization required |
| G5 (DNS / TLS for staging hosts) | **NOT AUTHORIZED** — separate explicit owner authorization required |
| G6 (write-path smoke / recovery rehearsal) | **NOT AUTHORIZED** — separate explicit owner authorization required |
| Production / hosting / DNS beyond this overlay | **NOT AUTHORIZED** — separate explicit owner authorization required |

Passing or closing an earlier gate never authorizes a later one.

---

## G3 — verified outcomes (do not invent beyond this list)

Recorded as closed for the pin and staging identity above:

- Step L (2026-10-17) **PASS**
- Steps 7–9 **COMPLETE** (migrations `001`–`020` applied once; second migrate idempotent)
- Batch B / Steps 11–16 **PASS / CLOSED**
- Step 14 **PASS**
- R1: `NO_FINDINGS` / `FAIL=0`
- Required post-migration privilege / function checks **PASS**
- App-role isolation probes **PASS**
- Authorized provider / Auth checks (Steps 5–6) **PASS**
- Staging identity remained correct through those steps
- Staging state unchanged by the read-only verification and app-role probes

Raw evidence and launchers are **outside** this repository (operator staging-evidence / staging-launchers). Do not commit secrets, stamps, passwords, or raw launcher output.

---

## Accepted residuals (remain **NOT VERIFIED** — do not relabel)

| Residual | Disposition |
|---|---|
| **F10** | `postgres:17` registry digest pin **NOT VERIFIED** |
| **F12** | Data API denial-cause discrimination **NOT VERIFIED** |
| R1 provider items | `R1-PROVIDER-DATA-API` / `R1-PROVIDER-AUTH-SETTINGS` remain `NOT_VERIFIED`, `required=false` |
| **R-F7** | L-pass artifact is an owner-operated accidental-skip guard, **not** cryptographic anti-tamper |

Do **not** claim “all controls green.”

---

## Explicit non-authorization

- Do **not** reopen G3 under this overlay.
- Do **not** remediate F10, F12, or R-F7 without a new explicit owner authorization that names that work.
- Do **not** start G4, G5, G6, production deployment, hosting changes, or DNS changes without a new explicit owner authorization.
- Do **not** infer next-phase work from G3 closeout or from this document alone.

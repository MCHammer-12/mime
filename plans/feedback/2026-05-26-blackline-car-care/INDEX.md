# Blackline Car Care feedback — 2026-05-26

Source: troubleshoot bundle `troubleshoot-Blackline Car Care-2026-05-21T16-17-54-283Z (1).zip`
Job: `9dfd5817-e261-4ef5-9042-2707b6fdc1e5` (storeId `mcht/6a078d6dcb8ab3e704738e23`)
Items: 1 template flagged

## Tasks

| # | Status | Task | Branch | PR |
|---|--------|------|--------|----|
| 1 | unclaimed | [Imported fonts render inconsistently in Redo editor](font-rendering-inconsistent.md) | `fix/font-rendering-inconsistent` | — |

## Cross-cutting notes

**Single-task batch.** Below the README's ≥5 threshold, but kept formal for consistency with the planner/executor workflow. If you spawn an executor, just hand them this task file directly.

**Likely cross-merchant.** Brand-kit font handling is general — if this bug is in mime's font pipeline (not Redo's editor), other merchants will hit it too. Possible interaction with Charlie 1 Horse Task 4 (`first-text-font-styling`) — same code area, different symptoms. Coordinate if both executors run in parallel.

**Klaviyo API key provided by Michael** for this session — executor can use it to re-fetch the Blackline source HTML directly via Klaviyo API (`GET /api/templates/{YvCSGH}/` with revision `2025-10-15`). Don't write the key into any file, env var, or commit; pull it from the operator at execution time if needed.

**Blackline contact info** (substituted at parse time):
- `organization.name` → `Blackline Car Care`
- `organization.full_address` → `3767 Lane Rd Ext, Ste 1, Perry, OH 44081, United States`
- Template missing-font flagged: **Futura**

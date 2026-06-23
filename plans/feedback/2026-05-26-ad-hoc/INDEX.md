# Ad-hoc findings — 2026-05-26

Findings NOT tied to a specific merchant troubleshoot bundle — surfaced from
direct questions, code review, or screenshots. Same task format + executor
workflow as the merchant batches.

## Tasks

| # | Status | Task | Branch | PR |
|---|--------|------|--------|----|
| 1 | done | [Flow condition on metric VALUE mistranslated as event COUNT](cart-value-condition-mistranslated.md) | `fix/condition-value-measurement` | [#110](https://github.com/MCHammer-12/mime/pull/110) |
| 2 | done | [Font preflight: map Klaviyo font → brand-kit font after adding](font-name-mismatch-mapping.md) | `fix/font-name-mismatch-mapping` | [#111](https://github.com/MCHammer-12/mime/pull/111) |
| 6 | unclaimed | [Condition timeframe in minutes → round to nearest hour (Redo supports hours only)](timeframe-minutes-round-to-hours.md) | `fix/timeframe-minutes-round-to-hours` | — |

(Tasks 3–5 — date-trigger, segment-auto-creation, started-checkout — live on their own in-flight PRs; numbering reflects creation order.)

## Cross-cutting notes

**Related condition-mapping work:** Yes Homo Task 1 ([`phone-country-code-condition`](../2026-05-26-yes-homo/phone-country-code-condition.md)) is also in `src/flow/condition-mapping.ts`. Different operator (profile-property phone-country vs metric value-measurement) but same file — coordinate if both executors run in parallel to avoid edit conflicts.

**Redo MCP now available.** Tools like `mcp__redo__get_automation_step_configuration` and `mcp__redo__get_automation` can fetch live Redo automation/condition JSON. Useful for confirming the exact target shape an executor needs to emit (instead of guessing the schema).

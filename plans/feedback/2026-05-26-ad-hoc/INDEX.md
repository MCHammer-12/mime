# Ad-hoc findings — 2026-05-26

Findings NOT tied to a specific merchant troubleshoot bundle — surfaced from
direct questions, code review, or screenshots. Same task format + executor
workflow as the merchant batches.

## Tasks

| # | Status | Task | Branch | PR |
|---|--------|------|--------|----|
| 1 | done | [Flow condition on metric VALUE mistranslated as event COUNT](cart-value-condition-mistranslated.md) | `fix/condition-value-measurement` | [#110](https://github.com/MCHammer-12/mime/pull/110) |
| 2 | done | [Font preflight: map Klaviyo font → brand-kit font after adding](font-name-mismatch-mapping.md) | `fix/font-name-mismatch-mapping` | [#111](https://github.com/MCHammer-12/mime/pull/111) |
| 3 | unclaimed | [Klaviyo date / predictive triggers crash import (50KB Zod 400)](date-predictive-trigger-failure.md) | `fix/date-predictive-trigger-failure` | _on [#113](https://github.com/MCHammer-12/mime/pull/113)_ |
| 4 | unclaimed | [Auto-create Redo segments at import (copy static lists, members included)](segment-auto-creation-at-import.md) | `fix/segment-auto-creation-at-import` | — |

## Cross-cutting notes

**Segment auto-creation (Task 4) is the foundational unblocker** for the condition/segment cluster. Decision by Michael 2026-06-12 (memory `feedback_segment_import_decision`): auto-create Redo segments at import; copy static Klaviyo lists with members. Dependents: SHOC Task 1 (list-membership condition), Tiny Boat Task 2 (list-update action). Gated on a merchant-facing create-segment RPC that does NOT yet exist in redoapp — Task 4's step 0 confirms/adds it. (Task 3 file lives on PR #113 until merged.)

**Related condition-mapping work:** Yes Homo Task 1 ([`phone-country-code-condition`](../2026-05-26-yes-homo/phone-country-code-condition.md)) is also in `src/flow/condition-mapping.ts`. Different operator (profile-property phone-country vs metric value-measurement) but same file — coordinate if both executors run in parallel to avoid edit conflicts.

**Redo MCP now available.** Tools like `mcp__redo__get_automation_step_configuration` and `mcp__redo__get_automation` can fetch live Redo automation/condition JSON. Useful for confirming the exact target shape an executor needs to emit (instead of guessing the schema).

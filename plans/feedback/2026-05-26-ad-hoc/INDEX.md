# Ad-hoc findings — 2026-05-26

Findings NOT tied to a specific merchant troubleshoot bundle — surfaced from
direct questions, code review, or screenshots. Same task format + executor
workflow as the merchant batches.

## Tasks

| # | Status | Task | Branch | PR |
|---|--------|------|--------|----|
| 1 | done | [Flow condition on metric VALUE mistranslated as event COUNT](cart-value-condition-mistranslated.md) | `fix/condition-value-measurement` | [#110](https://github.com/MCHammer-12/mime/pull/110) |
| 2 | done | [Font preflight: map Klaviyo font → brand-kit font after adding](font-name-mismatch-mapping.md) | `fix/font-name-mismatch-mapping` | [#111](https://github.com/MCHammer-12/mime/pull/111) |
| 3 | unclaimed | [Klaviyo date / predictive triggers crash import (50KB Zod 400)](date-predictive-trigger-failure.md) | `fix/date-predictive-trigger-failure` | — |
| 4 | partial | [Auto-create Redo segments at import (copy static lists, members included)](segment-auto-creation-at-import.md) — action-side (create/match) shipped; member-copy for conditions still gapped | `fix/segment-auto-creation-at-import` | [#121](https://github.com/MCHammer-12/mime/pull/121) |
| 5 | done | [Started Checkout → Checkout Abandonment (reverse PR #43)](started-checkout-to-checkout-abandonment.md) | `fix/started-checkout-to-checkout-abandonment` | [#122](https://github.com/MCHammer-12/mime/pull/122) |
| 8 | **unclaimed — URGENT** | [Flow emails blank — templates resolve to nothing + SIMPLE-editor gap; resolver is silent on why](flow-email-templateid-orphaned.md) | `fix/flow-email-templateid-orphaned` | — |

## Michael's decisions — 2026-06-12

Four open questions resolved this session (memory `feedback_segment_import_decision` + `feedback_migration_decisions`):
1. **Started Checkout → Checkout Abandonment** (reverses #43) → Task 5.
2. **Segment member-copy: ship buildable, defer copy.** Tag actions + list-update actions + rule-based segments now (Task 4's match-by-name/create path); static-list-membership *conditions* wait on a redoapp add-members RPC. SHOC Task 1 stays deferred; Tiny Boat Task 2's tag half ships now.
3. **WAIT time-of-day / weekday: accept as degraded mapping.** No new work — the existing degraded-mapping warning stands. Don't re-raise.
4. **Unknown custom-event metrics: always surface to the picker**, never silently map to a real trigger (e.g. survey → order_fulfilled). Locks Rufskin Task 1's direction.

## Cross-cutting notes

**Task 8 note:** #135 (fail-loud on placeholder templateId) was a DEFENSIVE fix for a different hypothesis — it did NOT resolve the Jack Henry blank emails. Real cause (2026-06-25 diagnosis): templates resolve to blank with no logged reason + a SIMPLE-editor parser gap. Surface the resolve-failure reason first.

**Segment auto-creation (Task 4) is the foundational unblocker** for the condition/segment cluster. Decision 2026-06-12 (memory `feedback_segment_import_decision`): ship the buildable parts now, defer static-list member-copy until redoapp adds an add-members RPC. Dependents: SHOC Task 1 (list-membership condition, deferred), Tiny Boat Task 2 (list-update action, buildable). (Task 3 file lives on PR #113 until merged.)

**Related condition-mapping work:** Yes Homo Task 1 ([`phone-country-code-condition`](../2026-05-26-yes-homo/phone-country-code-condition.md)) is also in `src/flow/condition-mapping.ts`. Different operator (profile-property phone-country vs metric value-measurement) but same file — coordinate if both executors run in parallel to avoid edit conflicts.

**Redo MCP now available.** Tools like `mcp__redo__get_automation_step_configuration` and `mcp__redo__get_automation` can fetch live Redo automation/condition JSON. Useful for confirming the exact target shape an executor needs to emit (instead of guessing the schema).

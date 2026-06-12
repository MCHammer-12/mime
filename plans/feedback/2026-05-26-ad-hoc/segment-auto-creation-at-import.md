---
status: unclaimed
branch: fix/segment-auto-creation-at-import
pr: null
---

# Auto-create Redo segments at import (copy static Klaviyo lists, members included)

## Decision (Michael, 2026-06-12)

> especially if the segment is needed in an automation. If it is a static list then we should copy it over automatically.

When a Klaviyo flow references an audience Redo can't express inline, mime should **create the Redo segment at import time** instead of leaving an empty branch + warning:
- **Rule-based** Klaviyo segment/condition → create a Redo segment with the translated rule.
- **Static** Klaviyo list → create a Redo static segment AND copy its members.

This is the foundational capability that unblocks several parked condition/action tasks. See memory `feedback_segment_import_decision`.

## Why this is needed

The silent-empty-branch fallback breaks targeting. Redo has the receiving structures (confirmed in redoapp):
- `STATIC_SEGMENT_MEMBERSHIP` + `CUSTOMER_TAGS` segment characteristics — `redo/model/src/marketing/segments/segment-types.ts:81,78`. So a conditional split CAN test "is in static segment X" / "has tag Y".
- `manage_static_segment` step — `redo/model/src/advanced-flow/advanced-flow-db-parser.ts:886` (`{ operation: add|remove, segmentId, ... }`).
- Both key on a real `segmentId` → the segment must exist. Auto-creating it is what makes the migrated flow work.

## The blocker — confirm/build a merchant-facing RPC FIRST

**There is no merchant-callable create-segment / add-members RPC in `redo/server/src/rpc` today.** Segment creation in redoapp is admin-side (`redo/admin/server/src/rpc/handler/marketing/create-expansion-segments.ts`) and klaviyo-push-side (`redo/integration/clients/klaviyo`). mime imports with a **merchant JWT** via merchant RPCs — it can't call admin handlers.

So step 0 is a redoapp dependency: confirm (or add) a merchant-facing RPC for:
1. **Create static segment** → returns `segmentId`.
2. **Add customers to a static segment** (by email or Redo customer id).
3. (Rule-based) **Create rule segment** from a `SegmentCondition[]` definition.

Use the Redo MCP (`list_segments` / `get_segment`) + redoapp source to see what's exposed. If the RPC doesn't exist, this task's first deliverable is the redoapp PR that adds it — coordinate with Michael / Redo eng. **Do not proceed to the mime side until the RPC contract is known.**

## Proposed change (once the RPC exists)

In [`src/migrate/import-rpc.ts`](../../../src/migrate/import-rpc.ts) (import path) + [`src/flow/condition-mapping.ts`](../../../src/flow/condition-mapping.ts) / [`src/flow/parser.ts`](../../../src/flow/parser.ts):

1. **A segment-resolution helper** that, given a Klaviyo list id or a rule definition, returns a Redo `segmentId`:
   - **Dedup first.** Keep a per-import cache keyed by Klaviyo list id / rule hash. N flows referencing the same list → ONE Redo segment. Also check existing Redo segments by name before creating (match-by-name).
   - **Rule-based:** translate the Klaviyo definition → Redo `SegmentCondition[]` (reuse the condition-mapping work — country #93, value #110, contains/is-set #116), create via the rule-segment RPC.
   - **Static list:** create the static segment, then fetch the Klaviyo list members (mime already has the Klaviyo client — `src/klaviyo.ts`, paginate), and add the matching Redo customers. **Members not yet in Redo (no matching email) can't be added — collect + report them, don't fail.**
2. **Wire the consumers:**
   - SHOC Task 1 (`profile-group-membership` condition) → emit a `STATIC_SEGMENT_MEMBERSHIP` condition referencing the resolved `segmentId`.
   - Tiny Boat Task 2 (`list-update` action) → emit a `manage_static_segment` step with the resolved `segmentId` + operation.
3. **Failure handling:** if segment creation fails (RPC error, no members resolvable), fall back to the current precise-warning behavior — never a silent empty branch.

## Verify

- A flow with a list-membership branch re-imports → the branch references a real Redo static segment; the segment exists on the merchant's account with the copied members (minus unmatched emails, which are reported).
- A flow with a `manage_static_segment` (ex-`list-update`) action → the step references the same segment (deduped, not a second copy).
- Rule-based segment (e.g. "country = US") → created as a rule segment, not a static copy.
- Dedup: two flows referencing the same Klaviyo list → one Redo segment.
- Failure path: RPC down → precise warning, flow still imports, no empty branch.
- Smoke + a real round-trip on a merchant with a list-membership flow.

## Notes

- **Cross-repo.** Likely a redoapp PR (the RPC) + a mime PR (the consumer). The redoapp side gates everything.
- **Static-list copy is a snapshot.** It copies current members at import; it does not keep syncing with Klaviyo. Document this for the operator — the Redo segment won't auto-update as the Klaviyo list changes (the merchant has left Klaviyo anyway, so this is usually fine).
- **Member-match is email-based.** Customers must already exist in Redo. Pair this with whatever customer-import step the migration runs; if customers are imported separately, sequence segment-copy after.
- Dependents to update once this lands: [SHOC Task 1](../2026-06-12-shoc/list-membership-condition.md), [Tiny Boat Task 2](../2026-06-12-tiny-boat-nation/tag-list-actions-to-redo-steps.md). Yes Homo Task 1 already resolved natively (country dimension) — no change.
- This is a big task. If the redoapp RPC is far off, an acceptable interim is **match-by-name only** (reference an existing same-named Redo segment; warn if absent) — ship that first, add auto-create when the RPC lands.

## Done

(filled by executor on completion)

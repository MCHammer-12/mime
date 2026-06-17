---
status: partial
branch: fix/segment-auto-creation-at-import
pr: 121
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

## Step 0 RESOLVED (2026-06-12) — RPCs exist; one gap

The "no merchant-callable create-segment RPC" premise is **stale**. The
merchant marketing RPC layer (`redo/merchant/marketing/rpc/src/schema/segments/`)
now exposes, callable with a merchant JWT:

| RPC | Input | Output | Use |
|-----|-------|--------|-----|
| `createStaticSegment` | `{ name }` | staticGroup (has `_id`) | create empty static segment |
| `createDynamicSegment` | `{ name, conditions: segmentSchema }` | dynamicGroup | create rule segment |
| `fetchTeamSegments` | `{ segmentType?, searchText?, page?, pageSize? }` | `{ segments[], totalCount }` | dedup + match-by-name |
| `updateStaticSegment` | `{ _id, name }` | staticGroup | **rename only** |
| `getSegmentMembers` | preview / export / static modes | members | read members |

**The one real gap: there is NO merchant RPC to ADD members to a static
segment.** `createStaticSegment` makes it empty, `updateStaticSegment`
only renames, `staticGroupSchema` carries no member array. So the
decision's "copy the static list WITH members" cannot be done merchant-side
today — it needs a new redoapp RPC (`addCustomersToStaticSegment` or
equivalent). That part stays blocked on redoapp.

**This splits the work by consumer:**

- **`list-update` ACTION (Tiny Boat Task 2) — buildable now.** The
  `manage_static_segment` step populates the segment at flow RUNTIME
  (`operation: add`), exactly like Klaviyo's list-update did. It only
  needs the segment to EXIST, not be pre-filled. So: match-by-name via
  `fetchTeamSegments`, else `createStaticSegment`, emit the step with the
  resolved `_id`. No member-copy required. ✅
- **List-membership CONDITION (SHOC Task 1) — still gapped for STATIC
  lists.** A "is in list X" condition needs the segment pre-populated to
  evaluate, which requires the missing add-members RPC. **Exception:** if
  the Klaviyo audience is RULE-BASED, translate it → `createDynamicSegment`
  (membership is computed, no copy needed). Static-list conditions wait on
  the add-members RPC.

Architecture note: the parser runs without a Redo connection (pure
translation), so it emits an intent marker (Klaviyo list id + name); the
IMPORT path (import-rpc.ts) resolves marker → real `segmentId` before
`createAdvancedFlow`. Mirrors the existing `__PLACEHOLDER_X__` template
resolution.

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

**ACTION-side slice SHIPPED — PR [#121](https://github.com/MCHammer-12/mime/pull/121) (2026-06-12).**

What landed: Klaviyo `list-update` ACTION → Redo `manage_static_segment`. At
import, `resolveSegmentSteps` matches an existing same-named Redo segment via
`fetchTeamSegments` (the "match-by-name interim" from Notes) and, when absent,
**creates** one via `createStaticSegment` — both merchant-callable RPCs exist
(see Step 0 RESOLVED). Deduped per unique Klaviyo list. The action populates the
segment at flow runtime, so **no member-copy is needed for this path** — the
segment only has to exist. Failure → chain-preserving WAIT + `segmentWarnings`.

**Still gapped (NOT in #121):**
1. **List-membership CONDITIONS over static lists** (SHOC Task 1, Yes Homo
   segment route) need the segment's *members* copied so a `customer is in
   segment X` check evaluates correctly at import time — not just at runtime.
   That needs a merchant-facing **add-members-to-static-segment RPC**, which
   does NOT exist in redoapp today (`updateStaticSegment` renames only). This is
   the one real remaining blocker; the "members included" half of this task's
   title lives here.
2. **DYNAMIC Klaviyo segments** → `createDynamicSegment({conditions})` is
   unbuilt (separate from static lists).

Net: the foundational *create/match* capability is proven and in use. Member-copy
for static-list CONDITIONS remains parked on the redoapp add-members RPC.

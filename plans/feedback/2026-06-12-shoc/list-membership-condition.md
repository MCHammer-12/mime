---
status: unclaimed
branch: fix/shoc-list-membership-condition
pr: null
---

# Klaviyo list-membership condition (`profile-group-membership`) dropped

## Feedback (verbatim)

SHOC `Back In Stock Flow - Standard` (SwZcfV): "the conditioner split was incorrect/incomplete."

Parse-result warning (the still-open part, distinct from the timeframe/value fixes):
```
profile-group-membership condition (is_member=true, klaviyo_list_ids=[Sfke4p]) — manual config required
```

i.e. a branch that checks "is the customer a member of Klaviyo list Sfke4p" migrated with no predicate.

## Root cause

A new condition shape not covered by the shipped condition work:
- Tiny Boat #116 (branch-conditions) handled profile-property `contains` / `is-set` and trigger-split list filters.
- Yes Homo #93 handled phone-country → `country` dimension.
- ad-hoc #110 handled value measurements.

**`profile-group-membership`** (membership in a Klaviyo list/segment) is none of those. mime emits the warning + an empty condition. It's the same family as the `manage_static_segment` discussion (Tiny Boat Task 2) — Klaviyo lists ≈ Redo static segments.

Files:
- [`src/flow/condition-mapping.ts`](../../../src/flow/condition-mapping.ts) — add the membership shape
- [`src/flow/parser.ts`](../../../src/flow/parser.ts)

## Proposed change

1. **Confirm Redo's representation of "is in segment/list."** Redo conditional-splits reference segments (the `manage_static_segment` step + segment conditions exist). Check whether a condition can test segment membership directly, and the exact shape — via redoapp source + Redo MCP (`get_automation_step_configuration` / `get_segment`).
2. **Map Klaviyo list id → Redo segment.** The hard part (same as Yes Homo's open segment question + Tiny Boat Task 2): Klaviyo `klaviyo_list_ids=[Sfke4p]` won't have a Redo segment id. Options:
   - Match by list name → existing Redo segment.
   - Create a static segment at import (the recurring auto-create-segment question — **needs Michael's decision**, shared with Tiny Boat Task 2 and Yes Homo).
   - If neither, emit a **precise** warning naming the list (id + name) so the operator wires it manually — not a silent empty branch.
3. Smoke case for `profile-group-membership` (is_member true/false).

## Verify

- SwZcfV (re-imported on current build) — the list-membership split has a real predicate OR a precise actionable warning, not empty.
- Regression: other condition shapes (#93, #110, #116) unchanged; batch-test.

## Notes

- **Do the SHOC re-import first** (see INDEX). This bundle is from 2026-05-21; confirm the membership condition is still dropped on current `main` before coding — the other SwZcfV complaints (timeframe, fonts) are already fixed.
- **Shares the auto-create-segment decision** with Tiny Boat Task 2 (`list-update → manage_static_segment`) and Yes Homo Task 1's segment route. If Michael green-lights segment auto-creation, all three benefit from one implementation. If not, all three fall back to match-by-name-or-warn. Worth deciding once, building once.
- Scope: just `profile-group-membership`. Don't expand to every Klaviyo segment-condition operator.

## Done

(filled by executor on completion)

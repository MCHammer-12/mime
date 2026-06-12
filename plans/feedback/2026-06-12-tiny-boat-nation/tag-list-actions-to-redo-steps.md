---
status: unclaimed
branch: fix/tag-list-actions-to-redo-steps
pr: null
---

# Klaviyo tag/list actions dropped — map to manage_customer_tags / manage_static_segment

## Feedback (verbatim)

Tiny Boat `Back In Stock Flow - Standard` (W2yEfw), reviewer:

> Custom tags and fields are not migrated.

## Root cause

Parse-result shows the flow dropped a `list-update` action:
```
action type "list-update" has no Redo equivalent — dropped, chain re-stitched past it
```

Per memory `feedback_drop_unsupported_actions` (2026-05-07), mime intentionally drops `update-profile` / `list-update` / `target-date` actions and re-stitches the chain. That policy was set when Redo had no equivalent step.

**But Redo now has matching steps.** The `createAdvancedFlow` step-type enum (seen in the Jackson Hole / Rufskin 400 dumps) includes:
- `"manage_customer_tags"` — add/remove customer tags
- `"manage_static_segment"` — add/remove from a static segment (Klaviyo "list")

So Klaviyo's tag + list-membership actions are now representable in Redo. The blanket drop is stale for this subset.

Mapping:
- Klaviyo **add/remove tag** action → Redo `manage_customer_tags` (operation add/remove, tagIds)
- Klaviyo **list-update** (add/remove from list) → Redo `manage_static_segment` (operation add/remove, segmentId)

Files:
- [`src/flow/parser.ts`](../../../src/flow/parser.ts) — action translation + the current drop logic
- [`src/flow/types.ts`](../../../src/flow/types.ts) — step types
- [`src/migrate/import-rpc.ts`](../../../src/migrate/import-rpc.ts) — RPC payload; `manage_static_segment` needs a Redo segment ID, which may require creating/resolving a segment at import time

## Proposed change

1. **Inspect W2yEfw's `klaviyo-flow.json`** for the exact `list-update` (and any tag) action shape — operation (add/remove), target list/tag id + name.
2. **Confirm Redo step shapes** for `manage_customer_tags` + `manage_static_segment` via redoapp source + Redo MCP (`get_automation_step_configuration` on a hand-built flow that has these steps). Capture: operation enum, tagIds vs tag names, segmentId resolution.
3. **Map in `parser.ts`:**
   - Tag actions → `manage_customer_tags`. Redo likely wants tag IDs; if Klaviyo gives tag names, resolve or carry names per Redo's accepted shape.
   - `list-update` → `manage_static_segment`. The hard part: Redo wants a `segmentId`. Klaviyo's list won't have a Redo segment id. Options: (a) match by name to an existing Redo segment, (b) create a static segment at import time, (c) if neither, fall back to the current drop + a clear warning. Confirm with Michael which — segment auto-creation is the same open question as Yes Homo's segment route.
4. **Supersede the drop for these subtypes only.** `update-profile` (custom profile *field* writes) likely still has no Redo equivalent — keep dropping those, but with a precise warning. The reviewer's "custom fields" half may fall here: if Klaviyo writes a custom profile property, and Redo has no profile-field-write step, that stays dropped + warned. Split the complaint: **tags → map; profile-field writes → keep dropped + warn precisely.**
5. Update memory `feedback_drop_unsupported_actions` once shipped (tags/lists no longer blanket-dropped).

## Verify

- W2yEfw re-imported: tag/list actions appear as `manage_customer_tags` / `manage_static_segment` steps (or, for list→segment, a clearly warned fallback if segment resolution is deferred).
- Smoke test: synthetic Klaviyo tag action → `manage_customer_tags`; list-update → `manage_static_segment` or warned.
- Regression: `update-profile` / `target-date` still dropped + re-stitched; chains stay valid. Other flows unaffected.

## Notes

- **Two halves to the complaint.** "Custom tags" → mappable now (this task). "Custom fields" (profile property writes) → likely still unsupported; keep dropped with a precise warning naming the field. Don't conflate.
- `manage_static_segment` needing a `segmentId` is the same auto-create-segment question raised in Yes Homo Task 1. If Michael wants segment auto-creation, it's reusable across both. If not, fall back to drop+warn for list-update and only ship the tag mapping now.
- This unblocks a category that recurs (tag-based flows are common in Klaviyo). Worth doing even though only one merchant flagged it.

## Done

(filled by executor on completion)

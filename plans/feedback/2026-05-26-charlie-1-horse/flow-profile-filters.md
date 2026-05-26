---
status: unclaimed
branch: fix/flow-profile-filters
pr: null
---

# Abandoned Cart flow — profile filters not migrated

## Feedback (verbatim)

UN3tf7 (Abandoned Cart flow):

> profile filters not found.

i.e. Klaviyo's flow has profile-level filters (the "only run for profiles where X" filter applied at flow entry — e.g. "is subscribed to email", "has placed >0 orders", "country = US"). Redo's flow comes out without them.

## Root cause

A Klaviyo flow definition has a top-level filter set distinct from per-step conditional splits. Look at the structure of Klaviyo's flow JSON for UN3tf7 (in `flow-UN3tf7/parse-result.json` if available, or pull from Klaviyo API directly):

Typical shape:
```json
{
  "definition": {
    "profile_filter": { … },     // ← this is the missing piece
    "actions": [ … ]              // the step graph
  }
}
```

The flow parser ([`src/flow/parser.ts`](src/flow/parser.ts)) likely walks `actions` to produce the step graph but doesn't read `profile_filter` and emit it as Redo's flow-level audience condition.

Relevant files:
- [`src/flow/parser.ts`](src/flow/parser.ts) — main flow parser
- [`src/flow/condition-mapping.ts`](src/flow/condition-mapping.ts) — Klaviyo condition → Redo condition translation (per memory, handles `profile-marketing-consent` already)
- [`src/flow/types.ts`](src/flow/types.ts) — flow types
- [`src/migrate/import-rpc.ts`](src/migrate/import-rpc.ts) — import RPC payload to redoapp

## Proposed change

1. Inspect UN3tf7's flow JSON. Find the `profile_filter` (or equivalent — Klaviyo schema may use different naming). Document its shape in this file once known.
2. In `src/flow/parser.ts`, read the profile filter, translate each clause via `condition-mapping.ts` (extend if Charlie's filter uses condition types not yet handled), and emit them as Redo's flow-level audience condition (or per-step entry condition, depending on what Redo's flow schema supports).
3. If Redo's flow schema doesn't have a flow-level filter equivalent, the next-best is to attach the filter as a conditional-split at the start of the flow. Confirm with Michael which shape Redo expects.
4. Surface any unrecognized profile-filter clauses as a `templateWarning` so the operator can review.

## Verify

- UN3tf7 re-imported: Redo flow has the equivalent profile filter set (visually inspect in the Redo flow builder)
- New smoke test exercising at least one common profile-filter shape (e.g. "is subscribed to email" — which `condition-mapping.ts` already handles for per-step splits)
- Flow without any profile filter still imports cleanly (regression — no false-positive empty filter emitted)

## Notes

- Memory `feedback_flow_status_mapping`: imported flows land inactive regardless. So even if the filter migrates correctly, the merchant won't accidentally start a misconfigured campaign.
- Coordinate with Task 9 (Browse Abandonment flow — product filter + re-entry). They likely share the same parser entry point. They can land as separate PRs; just don't conflict in `src/flow/parser.ts` edits.

## Done

(filled by executor on completion)

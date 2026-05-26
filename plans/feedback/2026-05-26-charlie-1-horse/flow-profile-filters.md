---
status: done
branch: fix/flow-profile-filter
pr: https://github.com/MCHammer-12/mime/pull/84
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

## Notes — executor investigation 2026-05-26

**Confirmed planner premise.** Fetched UN3tf7's Klaviyo flow JSON via
`/api/flows/UN3tf7/?additional-fields[flow]=definition`. Real shape:

```json
{
  "definition": {
    "triggers": [{ "type": "metric", "id": "UZjNmf", "trigger_filter": null }],
    "profile_filter": {
      "condition_groups": [{
        "conditions": [{
          "type": "profile-metric",
          "metric_id": "VCkQXS",
          "measurement": "count",
          "measurement_filter": {
            "type": "numeric", "operator": "equals", "value": 0
          }
        }],
        "conjunction_mode": "and"
      }]
    },
    "actions": [...],
    "entry_action_id": "..."
  }
}
```

The Klaviyo semantics: "only run this flow for profiles where the count of
metric VCkQXS equals 0" (likely the "Placed Order" metric — i.e. only run
for customers who haven't yet placed an order).

**Parser gap.** `src/flow/parser.ts` walks `definition.actions` but does
not read `definition.profile_filter`. `KlaviyoFlow` in
[`src/flow/types.ts:274`](../../../src/flow/types.ts#L274) acknowledges
the field (`profile_filter: unknown`) but the parser never touches it.
There IS existing handling of `action.data.profile_filter` — that's the
per-step conditional-split filter, a different field entirely.

**Why this can't ship as a parser-only fix:**

Redo's `AdvancedFlow` ([`src/flow/types.ts:250`](../../../src/flow/types.ts#L250))
has no obvious slot for flow-level profile audience:
- `steps[].skipConditions` is step-level and the existing handlers wire
  it to trigger-data fields (`isCartAbandoned`, `isBrowseAbandoned`),
  not profile-metric counts.
- `audience?: string[]` on `KlaviyoTrigger` is unused on the parsed side.
- Redo's flow builder UI almost certainly has a settings panel for
  audience filters, but the schema field name + shape isn't visible from
  the mime side. Needs Redo eng confirmation.

**Mapping considerations (for whoever unblocks this):**

- Klaviyo `profile-metric` count==0 → Redo's "exclude profiles who have
  done X" or "include only profiles who have done 0× X". The metric_id
  needs a Redo equivalent (Klaviyo metric IDs aren't portable; Redo
  likely uses semantic field names like `hasPlacedOrder`).
- Klaviyo profile_filter is conjunctive (`condition_groups` AND-ed
  together, conditions within a group OR-ed). Need to confirm Redo's
  combinator semantics.
- Per memory `feedback_flow_status_mapping`, imported flows land
  inactive — so even an imperfect translation won't fire a misconfigured
  campaign without merchant review.

**Recommended unblock path:**

1. Michael/Redo eng confirms (or extends) Redo's flow schema with a
   flow-level audience filter field on `AdvancedFlow` (working name:
   `profileFilter?: SchemaCondition[]`).
2. Mime extends [`src/flow/parser.ts`](../../../src/flow/parser.ts) to
   read `definition.profile_filter`, translate each clause via the
   existing `condition-mapping.ts` (extend the type map as needed —
   `profile-metric` count→ord operators), and attach to the parsed
   automation.
3. Surface unrecognized clauses as warnings (existing pattern; uses
   `ParseResult.warnings`).

Marking `blocked` — Redo schema confirmation needed.

## Done

(filled by executor on completion)

---
status: unclaimed
branch: fix/bundle-missing-blank-reasons
pr: null
priority: high — Task 10 (#140) is invisible in troubleshoot bundles
---

# Troubleshoot bundle drops the per-email blank reason (Task 10 gap)

## Origin
Jack Henry re-import 2026-06-25T20:43 (flow `Y9ivJd`), on fully-deployed code
(#140 + #141 + `d3f97e6` publish). Still 2 created / 6 blank — and the bundle's
`parse-result.json` shows the 6 blanks with **zero** template-resolve warnings.

## Root cause — #140 wired the reason to the wrong two sinks
#140 (Task 10) lifts the typed `ResolveFailure` reason into:
- `FlowImportResult.blankedTemplates` (the API return value) —
  [import-rpc.ts:862,879,1181](../../../src/migrate/import-rpc.ts) ✓
- a `template_blanked` progress event (live SSE / job log) ✓

But the **troubleshoot bundle** is built from the `flow_imported` event
([server.ts:1625-1647](../../../src/migrate/server.ts)), which serializes
`createdTemplateCount`, `blankTemplateCount`, `warningList: parsed.warnings`,
and `parsedAutomation` — and **NOT `result.blankedTemplates`**. So the reasons
never reach `parse-result.json`. The whole point of Task 10 — "a bundle now
says WHICH emails blanked and WHY" — does not hold for the downloadable bundle.

(Note: `parsed.warnings` is the *parse-pass* warning list. The resolve happens
at parse time too, so resolve-failure warnings from
[parser.ts:238](../../../src/flow/parser.ts) should also be in `parsed.warnings`
— verify they actually land there; the Jack Henry bundle had only condition
warnings, which suggests either the resolver wasn't passed an API key on that
parse, or the failures took a path that didn't push to `parsed.warnings`.
Whichever it is, the bundle must end up with a per-email reason.)

## Proposed change
1. Add `blankedTemplates: result.blankedTemplates` to the `flow_imported` event
   payload ([server.ts:1625](../../../src/migrate/server.ts)) AND the
   `flow_failed` payload ([server.ts:1658](../../../src/migrate/server.ts)).
2. Have the bundle builder write it into `parse-result.json` (a
   `blankedTemplates: [{ name, klaviyoTemplateId, reason }]` array).
3. Verify `parser.ts:238` resolve-failure warnings actually appear in
   `parsed.warnings` for a flow whose templates fail to resolve — if the parse
   that feeds the bundle runs without a resolver/API key, fix that too so the
   reason is computed at all.

## Verify
- Re-export a flow with ≥1 unresolvable template → `parse-result.json` lists
  each blanked email with `klaviyoTemplateId` + typed `reason`.
- A fully-resolving flow → empty/omitted `blankedTemplates` (no false entries).

## Why this is blocking
Until this ships, every "emails are blank" troubleshoot bundle is undiagnosable
from the bundle alone — we have to re-fetch the merchant's Klaviyo templates by
hand (as on Jack Henry, 3 rounds). This is the meta-fix that actually ends the
blindness Task 10 was supposed to end.

## Done
(filled by executor)

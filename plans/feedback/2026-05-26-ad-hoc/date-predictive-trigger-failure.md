---
status: unclaimed
branch: fix/date-predictive-trigger-failure
pr: null
---

# Klaviyo date / predictive-analytics triggers crash the flow import (50KB Zod 400)

## Feedback (verbatim)

Two failed-import bundles, both `createAdvancedFlow 400`:

- **Jackson Hole Fly Company** (`flow-WXXbzi`, "AI Repeat Customer Nurture"), 2026-06-09 — date trigger + predictive-analytics condition.
- **Rufskin** (`flow-HFqsSH`, "Happy Birthday Email - Standard"), 2026-06-12. Reviewer:
  > The birthday tag was not created correctly during the migration, so we had to manually create a birthday segment to trigger the flow. Additionally, because the flow duplication failed, none of the email content was migrated. We weren't able to copy over even the original template, so the entire email had to be rebuilt manually from scratch.

## Root cause — confirmed by error + redoapp source read

mime maps Klaviyo's `date` trigger → Redo `{ key: "date", schemaType: "marketing_date" }` ([trigger-mapping.ts:322-323](../../../src/flow/trigger-mapping.ts)) but emits it **without the required `triggerSpecificFields`**. Redo's `createAdvancedFlow` Zod validation rejects the trigger step → 400. The 50KB error wall is a single discriminated-union failure on `steps[0]`, with Zod dumping every step-variant alternative.

The concrete missing field (from both error.txt files):
```
"triggerSpecificFields": { "_errors": ["Invalid input: expected object, received undefined", ...] }
```

**Redo's `date` trigger only supports BIRTHDAY.** From redoapp `redo/model/src/advanced-flow/triggers.ts:204`:
```js
const marketingDateTriggerFields = [ CustomerCharacteristicType.BIRTHDAY ] as const;
export type MarketingDateTriggerField = (typeof marketingDateTriggerFields)[number];
```
So the date trigger expects `triggerSpecificFields` naming the BIRTHDAY characteristic. mime emits nothing.

Two distinct merchant cases:
1. **Rufskin = birthday flow** (the supported case). With `triggerSpecificFields: [BIRTHDAY]` emitted, this should import cleanly. **This is the fixable win.**
2. **Jackson Hole = predictive date + `profile-predictive-analytics` condition** (NOT supported). Klaviyo predicts a next-order date and gates on ML analytics. Redo has neither. mime also emitted that condition as an empty `conditions: []` (`70478244`), flagged "profile-predictive-analytics not yet translated." Even with the trigger fixed, this flow can't fully map — it should **fail gracefully with a clear reason**, not a Zod wall.

## Proposed change

Two parts:

### Part A — make birthday date triggers actually import
1. In [`trigger-mapping.ts`](../../../src/flow/trigger-mapping.ts), when mapping Klaviyo's `date` trigger, detect whether it's a **birthday** trigger. Klaviyo birthday flows trigger on a date property — confirm the Klaviyo shape from Rufskin's `flow-HFqsSH/klaviyo-flow.json` (look at the trigger's date-property field; likely `$birthday`/`Birthday` or a profile date property).
2. Emit `triggerSpecificFields` in the shape Redo expects. Confirm exact shape from redoapp's trigger schema (`triggers.ts` + the `createAdvancedFlow` input zod) — likely `{ field: "birthday" }` or `{ characteristicType: BIRTHDAY }` keyed under the marketing_date variant. **Use the Redo MCP** (`get_automation_step_configuration` on a hand-built birthday automation) to capture the exact JSON rather than guessing.
3. If the Klaviyo date property is NOT a birthday (anniversary, custom date, predicted date) → Part B.

### Part B — fail non-birthday date + predictive triggers gracefully
1. Detect: Klaviyo `date` trigger whose property isn't birthday, OR a `profile-predictive-analytics` condition anywhere in the flow.
2. Instead of emitting an invalid trigger + empty condition that 400s, **fail the flow at parse time** with a typed, readable reason: e.g. `"This flow uses a Klaviyo feature Redo doesn't support: <predictive analytics | non-birthday date trigger>. Skipped — rebuild manually."`
3. Surface it in the import UI as a clean per-flow failure (the bundle already carries `error.txt` + warnings) — NOT a 50KB Zod dump. The operator should immediately understand why.

### Part C (defensive) — never ship a trigger Redo will 400 on
Consider a pre-flight validation in [`import-rpc.ts`](../../../src/migrate/import-rpc.ts) (`importFlowRpc`) that checks the trigger has its required variant fields before POSTing. If a required field is missing, fail with mime's own clear message rather than letting Redo's Zod produce the wall. This protects against the next unmapped trigger type too.

## Verify

- **Rufskin HFqsSH re-imports successfully** — birthday trigger lands with `triggerSpecificFields: [BIRTHDAY]`, email content migrates. (This is the headline check.)
- Jackson Hole WXXbzi fails with a one-line readable reason ("predictive analytics not supported"), not a 400 Zod wall.
- New smoke test: a synthetic birthday flow → valid trigger payload; a synthetic predictive flow → graceful typed failure.
- Regression: existing trigger types (email_signup, cart_abandoned, order_tracking, etc.) unchanged — batch-test the corpus flows.

## Notes

- **2 merchants in 4 days** (Jackson Hole 06-09, Rufskin 06-12). Birthday flows are common — this likely affects many merchants silently (every birthday flow fails import today).
- The `target-date` action drop (Rufskin warning) is separate + already handled by the drop-policy (memory `feedback_drop_unsupported_actions`). Not part of this task.
- Confirm the exact `triggerSpecificFields` shape against redoapp — the birthday characteristic may need a specific nested structure (offset/time-of-send). Klaviyo birthday flows often send "on birthday at 9am" or "N days before"; check whether Redo's birthday trigger carries a send-offset and whether mime needs to translate it.
- Cross-link: Rufskin batch [`2026-06-12-rufskin/INDEX.md`](../2026-06-12-rufskin/INDEX.md) collapses HFqsSH into this task.

## Done

(filled by executor on completion)

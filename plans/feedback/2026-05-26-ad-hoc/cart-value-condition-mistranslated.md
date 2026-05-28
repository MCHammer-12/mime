---
status: unclaimed
branch: fix/condition-value-measurement
pr: null
---

# Flow condition on metric VALUE mistranslated as event COUNT

## Feedback (verbatim)

Surfaced 2026-05-26 from Michael comparing a Klaviyo split vs. the hand-built Redo equivalent (screenshots).

**Klaviyo split:** "Added to Cart **Value** is greater than 74.99 in the last 30 days" — a value/sum (dollar) measurement.

**Correct Redo equivalent (hand-built):** "Added product to cart, at least once, in the last 30 days, **where Cart subtotal is greater than 74**" — count = at_least_once + a whereCondition on cart subtotal.

mime does NOT produce that. It mistranslates the dollar threshold into an event count.

## Root cause — confirmed by code read

[`src/flow/condition-mapping.ts:101-133`](../../../src/flow/condition-mapping.ts) `translateProfileMetricCondition`:

```js
const operator = c.measurement_filter?.operator ?? "greater-than";
const value = Number(c.measurement_filter?.value ?? 0);   // 74.99
return {
  type: "customer_activity",
  activityType,                              // added-product-to-cart
  count: translateCount(operator, value),    // <-- 74.99 routed through COUNT
  timeframe: translateTimeframe(...),
  whereConditions: [],                       // <-- ALWAYS empty
};
```

`translateCount("greater-than", 74.99)` ([line 35](../../../src/flow/condition-mapping.ts)) does `Math.floor(74.99) = 74` → `{ type: "greater_than_n", n: 74 }`.

**Result:** mime emits "added product to cart **more than 74 times** in the last 30 days" instead of "added to cart at least once **where cart subtotal > 74.99**".

Two concrete gaps:
1. **The Klaviyo `measurement` type is never read.** Klaviyo distinguishes `count` (number of events) from `sum_value` / value measurements (dollar sum of a property like `$value`). `translateProfileMetricCondition` assumes count for everything.
2. **`whereConditions` is hardcoded `[]`** — the only place it's set in the whole file. The value comparison that belongs there is dropped.

Partial existing infra: [`resolveTriggerField:162`](../../../src/flow/condition-mapping.ts) maps `$value → cartSubtotal`, but ONLY for checkout-abandonment **trigger-split** expressions (TriggerData path), not for the profile-metric **conditional-split** in the screenshots.

## Proposed change

1. **Read the Klaviyo `measurement` field** on the profile-metric condition (`c.measurement` — the selector that's `count` vs `sum_value` / `value`). Confirm the exact Klaviyo shape by fetching one real example via Klaviyo API (a flow that uses a cart/order-value split), or from the corpus.
2. **Branch on measurement type in `translateProfileMetricCondition`:**
   - `count` (or absent) → current behavior (`translateCount` → count threshold). No change.
   - `sum_value` / value-type → emit `count: { type: "at_least_once" }` PLUS a `whereConditions` entry carrying the value comparison.
3. **Build the whereCondition.** Map the Klaviyo value property to the Redo activity's value field. For added-to-cart, that's cart subtotal. Confirm the exact Redo shape:
   - The `SegmentConditionBlock` interface is at `segment-types.ts:177` (referenced in the comment at [`condition-mapping.ts:389`](../../../src/flow/condition-mapping.ts)).
   - **Best move: fetch a live example.** Use the Redo MCP (`mcp__redo__get_automation_step_configuration`) on a hand-built automation that has an "added to cart where cart subtotal > X" condition (Michael can point you at one, or rebuild the screenshot's condition in a test automation). The returned JSON gives you the exact `whereConditions[]` element shape — field name, operator enum, value type.
   - The existing `customer_attribute` path at [`condition-mapping.ts:377-384`](../../../src/flow/condition-mapping.ts) shows a `whereCondition` (singular) shape for boolean dimensions — useful as a structural reference but NOT the same as the activity `whereConditions` (plural) array.
4. **Map operators.** Klaviyo `greater-than` / `greater-than-or-equal` / `less-than` / etc. → Redo's whereCondition comparison operators. The `NUMBER_OP_TO_COMPARISON` map at [`condition-mapping.ts:178`](../../../src/flow/condition-mapping.ts) already exists for the trigger-split path — reuse or mirror it.

## Verify

- Synthetic Klaviyo "Added to Cart Value > 74.99 in last 30 days" → Redo `customer_activity` / `added-product-to-cart` / `count: at_least_once` / `timeframe: before-now-relative 30 day` / `whereConditions: [{ cart subtotal, greater-than, 74.99 }]`
- New smoke case in [`src/flow/condition-mapping.smoke.ts`](../../../src/flow/condition-mapping.smoke.ts) covering value-measurement
- Regression: existing count-based conditions (`zero_times`, `at_least_once`, `greater_than_n`) unchanged — the smoke file already covers sms/email/unsubscribed/unknown-channel; don't break those
- If feasible, round-trip: import a real flow with a value-split, open in Redo editor, confirm the condition reads correctly (not "74 times")

## Notes

- **Merchant-impacting, possibly silent across many flows.** Any flow split on cart value, order value, or any `sum_value` metric measurement gets silently-wrong logic ("N times" instead of "$N threshold"). No warning is emitted today because the code thinks it succeeded. Worth a corpus scan: grep extracted flows for `"measurement": "sum_value"` (or whatever the real key is) to size the blast radius.
- Consider emitting a warning if the measurement type is one we DON'T handle yet (e.g. `unique`), rather than silently routing through count.
- Scope: just the value/sum measurement → whereCondition translation. Don't expand into other measurement types unless trivial. The phone-country-code profile-property condition (Yes Homo Task 1) is a separate fix in the same file.

## Done

(filled by executor on completion)

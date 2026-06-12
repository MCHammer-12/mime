---
status: done
branch: fix/branch-conditions-dropped
pr: https://github.com/MCHammer-12/mime/pull/116
---

# Branch/split conditions on profile + event properties silently dropped

## Feedback (verbatim)

Two flows flagged by the reviewer, plus a third found in parse-results:

- **SD8SuS** (BM | Browse Abandonment): "The branch logic is not being migrated correctly. In this case, the branch that targets subscribers who have recently viewed the ePropulsion collection was not carried over and would need to be recreated manually in Redo."
- **X3KsN3** (BM | Abandoned Cart Reminder): "the conditional split that segments customers based on whether they added a specific product to their cart was not migrated properly and would need to be recreated manually."
- **W2yEfw** (Back In Stock, found in parse-result): `phone_number is-set` condition → empty.

## Root cause

Each flagged conditional-split / branch migrates with an **empty `conditions: []`** inside the condition step's inline segment. The branch keeps its true/false edges but has no predicate, so it silently routes all traffic one way. mime emits a "manual config required" warning and an empty expression rather than translating the condition.

Confirmed in parse-results (each condition step shows `inner-conditions: 0`):

- SD8SuS warning: `profile-property condition (properties['$viewed_items'] contains "ePropulsion") — manual config required`
- X3KsN3 warning: `trigger-split on Klaviyo field "Items" has no Redo schema field for marketing_cart_abandonment — manual config required`
- W2yEfw warning: `profile-property condition (phone_number is-set "") — manual config required`

These are **three different mechanisms** with the same symptom:
1. **Profile-property list-contains** — `$viewed_items contains "ePropulsion"` (a Klaviyo list property holding viewed collections/items)
2. **Trigger-data split on cart Items** — "added specific product to cart" keys on the trigger's `Items` field; Redo's `marketing_cart_abandonment` trigger schema has no matching field per the warning
3. **Profile-property is-set** — `phone_number is-set` (existence check on a profile field)

This is the **broad version of Yes Homo Task 1** ([phone-country-code-condition](../2026-05-26-yes-homo/phone-country-code-condition.md), PR [#93](https://github.com/MCHammer-12/mime/pull/93)), which mapped `phone-country-code-in` → native Redo `country` dimension. That task's notes predicted exactly this: "extends beyond phone country codes — equals, contains, is-set, is-in-set."

Files:
- [`src/flow/condition-mapping.ts`](../../../src/flow/condition-mapping.ts) — profile-property + trigger-split translation (already handles country, phone-consent; this adds operators/fields)
- [`src/flow/parser.ts`](../../../src/flow/parser.ts) — calls condition-mapping
- [`src/flow/types.ts`](../../../src/flow/types.ts)

## Proposed change

Translate the three condition shapes. **Confirm each target against redoapp source + Redo MCP (`get_automation_step_configuration`) — do not guess the schema.** For each, the outcome is one of: native dimension mapping (best, like country), or a clear named warning if Redo genuinely can't represent it (acceptable — but the warning must name the exact predicate so the operator can rebuild).

1. **`$viewed_items contains X` (SD8SuS).** Find Redo's equivalent for "viewed product/collection" targeting. Browse-abandonment context already exposes viewed-product data (Charlie Task 7). Check whether Redo has a `customer_activity` `viewed-product` with a `whereConditions` on collection/product, or a customer-attribute dimension for viewed items. Map `contains` → the right operator. If no native target → named warning.
2. **Trigger-split on cart `Items` (X3KsN3).** "Added specific product to cart." The warning says `marketing_cart_abandonment` has no Redo schema field for "Items." Check `resolveTriggerField` in condition-mapping.ts (it maps `Name → productInCartName` for cart abandonment). "Items"/"added specific product" may map to `productInCartName` or a SKU/product-id field. Confirm the cart-abandonment trigger schema fields in redoapp; map if one fits, else named warning.
3. **`phone_number is-set` (W2yEfw).** Existence check. Redo likely has an `is-set`/`exists` operator on customer attributes (the `phone` attribute). Map `is-set` → that operator. If only boolean dimensions exist, approximate (has-phone) or warn.

For all three: when a real mapping exists, emit a populated condition (never empty). When it doesn't, keep the empty-branch behavior BUT make the warning actionable (exact property + operator + value), and consider whether to drop the branch entirely vs leave it (dropping silently routes all traffic — leaving an always-true/false predicate may be safer; decide per case and document).

Add smoke cases in [`condition-mapping.smoke.ts`](../../../src/flow/condition-mapping.smoke.ts) for each shape.

## Verify

- SD8SuS re-parsed: the ePropulsion-viewed branch has a real predicate (or a precise actionable warning), not empty.
- X3KsN3 re-parsed: the added-specific-product split has a real predicate or precise warning.
- W2yEfw re-parsed: the phone is-set condition translated or precisely warned.
- Regression: country + phone-consent conditions (Yes Homo #93) still work; existing customer_activity / customer_attribute splits unchanged. Batch-test the corpus.

## Notes

- **Scope discipline:** these 3 concrete shapes, plus obvious siblings if trivial (e.g. `is-not-set`, `does-not-contain`). Don't attempt every Klaviyo profile-property operator — that's a bigger design conversation. Each shape that can't map cleanly gets a precise warning, not a silent empty branch.
- **Silent-empty is the real harm** (same theme as Rufskin's survey mis-resolve): a branch with no predicate routes everyone one way. Even though imported flows land inactive (memory `feedback_flow_status_mapping`), an operator may enable trusting it. If a shape can't be translated, strongly prefer a loud warning + a predicate that fails safe over a silent empty `conditions: []`.
- Coordinate with `condition-mapping.ts`'s other in-flight work (ad-hoc value-measurement #110, Yes Homo country #93 — both merged). Same file; rebase-aware.

## Done

- PR: https://github.com/MCHammer-12/mime/pull/116
- Inspected the bundled `klaviyo-flow.json` for each flagged flow; exact
  shapes:
  - SD8SuS: `{profile-property, property: properties['$viewed_items'],
    filter: {type:list, value:"ePropulsion", operator:contains}}`
  - X3KsN3: `{trigger-split/metric-property, field:"Items", filter:{type:
    list, value:"Epropulsion", operator:contains}}`
  - W2yEfw: `{profile-property, property:phone_number, filter:{type:
    existence, operator:is-set}}`
- All targets confirmed against checked-out redoapp source (no guessing):
  - **SD8SuS → mapped.** `customer_activity` `viewed-product` +
    `collection_name` TOKEN_LIST whereCondition (`{type:list, operator:any,
    values:["ePropulsion"]}`). `ProductViewedSegmentFields.COLLECTION_NAME`
    = `collection_name` (TOKEN_LIST), `ListCompareOperators` any/none.
    `not-contains` → none. degraded-mapping warning notes the
    profile-snapshot → event-history approximation.
  - **X3KsN3 → mapped.** trigger-data `text_match` on `productInCartName`
    (`includes`). `resolveTriggerField` now maps `Items` → productInCartName
    for cart abandonment; new list-filter branch in
    `translateTriggerSplitExpression` does contains→includes /
    not-contains→notIncludes.
  - **W2yEfw → precise warning.** Redo has NO is-set/existence operator
    (where-condition operators: token ANY/NONE, numeric eq/gt, boolean).
    Keeps the placeholder, which emits `phone_number is-set ""` — loud,
    not silent. Per `feedback_flow_status_mapping`, imported flows land
    inactive so the operator reviews.
- Verified each against the real flow JSON via direct translator calls;
  outputs exactly as above. 5 new smoke cases; existing condition / flow /
  416-template batch unchanged; tsc clean.
- **Not in scope (per the task's scope-discipline note):** other arbitrary
  Klaviyo profile-property operators (`equals`/`starts-with` on custom
  fields, `is-in-set`, group membership). Those still hit the
  manual-config placeholder — a broader design conversation, not this
  3-shape fix.

## Done

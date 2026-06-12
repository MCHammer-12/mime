---
status: unclaimed
branch: fix/started-checkout-to-checkout-abandonment
pr: null
---

# Started Checkout → Checkout Abandonment (reverse the PR #43 cart-abandonment mapping)

## Decision (Michael, 2026-06-12)

Klaviyo "Started Checkout" / "Checkout Started" triggers should map to Redo **Checkout Abandonment**, not Cart Abandonment.

This **reverses** the deliberate PR [#43](https://github.com/MCHammer-12/mime/pull/43) decision (2026-05-08, eng-concurred) that collapsed Started Checkout → `MARKETING_CART_ABANDONMENT` on merchant-naming grounds. Michael's call: strict semantics win — Started Checkout is checkout abandonment.

Surfaced by **Rufskin HseqBM** ("Abandoned Cart" flow, Started Checkout trigger, reviewer wanted Checkout Abandonment) and **SHOC R3uzmb** ("Abandoned Checkout - Shopify Started Checkout Trigger").

## The change

[`src/flow/trigger-mapping.ts:42-49`](../../../src/flow/trigger-mapping.ts) — flip the two Started-Checkout aliases (leave `added to cart` on line 50 as Cart Abandonment — that one is correct):

```js
// before (PR #43)
"started checkout": { key: CART_ABANDONED,     schemaType: MARKETING_CART_ABANDONMENT,     category: "Marketing" },
"checkout started": { key: CART_ABANDONED,     schemaType: MARKETING_CART_ABANDONMENT,     category: "Marketing" },
// after
"started checkout": { key: CHECKOUT_ABANDONED, schemaType: MARKETING_CHECKOUT_ABANDONMENT, category: "Marketing" },
"checkout started": { key: CHECKOUT_ABANDONED, schemaType: MARKETING_CHECKOUT_ABANDONMENT, category: "Marketing" },
```
Confirm `MarketingTriggerKey.CHECKOUT_ABANDONED` (`"checkout_abandoned"`) + `SchemaType.MARKETING_CHECKOUT_ABANDONMENT` exist in mime's enums (the line-44 comment references the schemaType, and `checkout_abandoned` is a valid Redo key — no Zod-400 risk). Rewrite the 42-47 comment to record the reversal + reason + date.

## Ramifications to verify (this is why it's a task, not a one-liner)

1. **Checkout-URL / `/cart` link logic.** PR #43 also made cart-deeplink buttons emit static `<storeUrl>/cart` (memory `project_redo_checkout_url_resolution`). That rewrite keys on Klaviyo's checkout-URL *variables*, not on the cart-vs-checkout trigger, so it likely still applies — but **verify**: re-parse a Started-Checkout flow and confirm buttons still resolve sensibly under the checkout-abandonment schemaType. If checkout abandonment should deeplink to `/checkout` rather than `/cart`, note it.
2. **Dynamic variables.** Confirm `MARKETING_CHECKOUT_ABANDONMENT` exposes the dynamic vars the migrated templates use (cart subtotal, product-in-cart, etc.) the same way cart abandonment did. Per the schemaType-inheritance work (PR #61), the template's schemaType follows the trigger — so flipping the trigger flips the template's exposed vars. Make sure nothing that rendered under cart-abandonment now goes unbound.
3. **Skip-conditions.** Memory `project_redo_smart_sending_skip_conditions`: abandonment automations need `shouldSkipSmartSending` + an explicit `isCartAbandoned==false` (or `isCheckoutAbandoned==false`?) skip condition. Check whether the skip-condition field name is trigger-specific and update if checkout abandonment uses a different boolean.
4. **Merchant-naming side effect (expected, acceptable per decision).** A flow a merchant *named* "Abandoned Cart" but triggered on Started Checkout will now import as a Checkout Abandonment flow. That's the intended semantic correctness; the flow name is preserved regardless.

## Verify

- Re-parse Rufskin HseqBM + SHOC R3uzmb: trigger = `checkout_abandoned` / `marketing_checkout_abandonment`.
- Buttons + dynamic vars still resolve under the new schemaType (ramification 1+2).
- `trigger-mapping.smoke.ts` updated; `added to cart` still → cart abandonment (regression).
- Batch-test corpus: no flow breaks; confirm the count of flows that move from cart→checkout abandonment is the Started-Checkout set only.

## Notes

- **Reverses an eng-concurred decision** — worth a heads-up to whoever concurred on #43 (2026-05-08) so the change isn't a surprise. The reasoning then was merchant-naming; the reasoning now is semantic correctness + reviewer feedback.
- Update memory `project_redo_checkout_url_resolution` + the SESSION-LOG/DECISIONS note for #43 to record the reversal once shipped.
- Keep scope to the two Started-Checkout aliases. Don't touch `added to cart`, browse, or other triggers.

## Done

(filled by executor on completion)

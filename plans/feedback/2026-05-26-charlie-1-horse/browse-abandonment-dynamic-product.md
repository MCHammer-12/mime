---
status: blocked
branch: fix/browse-abandonment-dynamic-product
pr: null
---

# Browse Abandonment dynamic product variable not mapped — "Product image not found"

## Feedback (verbatim)

VRDxJu (Browse Abandonment):

> Product image not found

The bundle's `parse-result.json` is the smoking gun:

```
"warnings": [
  "Unknown block type in component-wrapper (text: \"{{ event.Name }}\nPrice: {{ event.Price|striptags }}...\")"
]
```

Klaviyo's browse-abandonment template references the viewed product via `{{ event.Name }}` / `{{ event.Price }}` (and presumably `{{ event.ImageURL }}` or similar). mime doesn't recognize the wrapping component and emits a warning instead of producing a Redo block.

## Root cause

Two layers:
1. **Variable mapping** — `event.Name`, `event.Price`, `event.ImageURL`, `event.URL` for Browse Abandonment are NOT in [`src/parser/url-mapping.ts`](src/parser/url-mapping.ts)'s known mapping. They're the standard set of dynamic vars exposed under `MARKETING_BROWSE_ABANDONMENT` in Redo.
2. **Component-wrapper detection** — the parse warning says `"Unknown block type in component-wrapper"`. So the kl-product wrapper is recognized as a component but the inner block (likely an image-with-overlay-text Klaviyo "product card" component) isn't matched to a Redo block.

Per memory `project_products_block_mapping`, Browse Abandonment should map kl-product → interactive-cart with **Viewed Product** filter.

## Proposed change

1. Pull VRDxJu source HTML. Identify the exact Klaviyo block markup that's emitting the unknown-block warning.
2. **Add Browse Abandonment variable mappings.** In `src/parser/url-mapping.ts` (or wherever Klaviyo `event.*` variables map to Redo dynamic-variable schemaFieldNames), add:
   - `event.Name` → product name dynamic variable
   - `event.Price` → product price dynamic variable
   - `event.ImageURL` → product image dynamic variable
   - `event.URL` → product URL dynamic variable
   (Confirm exact Redo schemaFieldName values by inspecting an existing Browse Abandonment template in the Redo editor or checking the `marketing_browse_abandonment` schema in redoapp.)
3. **Emit interactive-cart block** with Viewed Product filter when the BA component wrapper is detected. Mirrors Task 2's approach for AC + Cart Item, but for BA + Viewed Product.
4. Update the component-wrapper detection in [`src/parser/index.ts`](src/parser/index.ts) or `klaviyo-specific.ts` to recognize the BA product-card and route to the new emitter instead of warning.

## Verify

- VRDxJu re-parsed: no `"Unknown block type"` warning; emits an interactive-cart block with Viewed Product filter
- Visual viewer: browse-abandonment email shows a product card placeholder matching the schema
- New smoke test covering BA dynamic-product block

## Notes

- Task 2 covers cart/AC (Cart Item filter). This task is the matching pattern for Browse Abandonment (Viewed Product filter). They share infrastructure — coordinate so the trigger-to-filter mapping table is defined once, used by both.
- Don't ship without verifying the Redo `marketing_browse_abandonment` schema actually exposes the variables you're claiming. If `event.Name` doesn't have a clean equivalent, surface that and ask Michael.

## Notes — executor investigation 2026-05-26

**Confirmed both layers from the planner notes:**

1. **Component-wrapper detection** — the BA "product card" lives in a
   `<td class="kl-table">` containing `<td class="kl-table-subblock">`,
   with `<img src="{{ event.ImageURL }}">` and inline `{{ event.Name }}` /
   `{{ event.Price }}` text. The parser's dispatcher in
   [`src/parser/index.ts`](../../../src/parser/index.ts) has no explicit
   `kl-table` branch — only `kl-text`, `kl-image`, `kl-button`,
   `kl-split`, divider, socials, `kl-product`, and the `event.extra.line_items`
   UCB. The block falls through to the "Unknown block type in
   component-wrapper" fallback.

2. **Variable mapping** — `event.Name`, `event.Price`, `event.ImageURL`,
   `event.URL` aren't in [`url-mapping.ts`](../../../src/parser/url-mapping.ts).

**Why this can't ship as a parser-only fix:**

The proper Redo target is an `interactive-cart` block with a viewed-product
filter. But [`renderer/types.ts:317`](../../../src/renderer/types.ts#L317)
declares:

```ts
productRecommendationType:
  | "best_sellers"
  | "products_added_to_cart"
  | "collection"
```

There is no `viewed_products` value. Searching the whole mime tree turns
up zero references to `browseContext` / `viewedProducts` / a BA-specific
schemaFieldName (only `cartContext` exists, set when
`{% for item in event.extra.line_items %}` is detected). Flow-side
infrastructure DOES recognize BA (`SchemaType.MARKETING_BROWSE_ABANDONMENT`
in [`flow/types.ts`](../../../src/flow/types.ts), `BROWSE_ABANDONED` in
trigger-mapping), but the product-block schema has no slot for it.

**Recommended unblock path (Redo-side first, mime second):**

1. Redo eng confirms (or extends) the ProductsBlock schema with a BA
   recommendation type, e.g. `productRecommendationType: "viewed_products"`
   and the matching `schemaFieldName: "browseContext"` resolver.
2. Mime updates [`product.ts`](../../../src/parser/blocks/product.ts):
   - Add `VIEWED_PRODUCT_FILTER` with the new recommendation type
   - Add a `parseBrowseAbandonmentCardBlock` that recognizes the
     `kl-table` + `event.Name|Price|ImageURL` shape and emits an
     `interactive-cart` block with the new filter + `schemaFieldName:
     "browseContext"`. Mirrors `parseLineItemsUcbBlock` for AC.
   - Wire it into the dispatcher BEFORE the spacer/unknown fallback in
     [`index.ts`](../../../src/parser/index.ts).
3. Verify on Charlie VRDxJu — `"Unknown block type"` warning should
   disappear and the BA template should preview a viewed-product card
   in Redo's editor.

**Alternative partial fix (NOT shipping pending Redo decision):**

Emit `interactive-cart` with **Best Sellers** as the fallback filter
when the BA card pattern is recognized. Pros: removes the unknown-block
warning; merchant sees a product block. Cons: shows best-sellers, not
the viewed product — semantically wrong, may mislead the merchant into
thinking BA dynamic resolution works. Don't ship without explicit OK
from Michael.

Marking `blocked` — needs Redo schema extension before a real fix lands.

## Done

(filled by executor on completion)

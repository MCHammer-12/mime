---
status: unclaimed
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

## Done

(filled by executor on completion)

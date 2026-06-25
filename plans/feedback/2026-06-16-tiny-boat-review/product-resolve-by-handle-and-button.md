---
status: unclaimed
branch: fix/product-resolve-by-handle-and-button
pr: null
---

# Static product not selected — resolve by Shopify handle; carry the product button

## Feedback (verbatim)

Tiny Boat (AutoBoat, R3rU5j), Michael: "in Klaviyo it uses a static product block and in Redo we did the manual product block which is the right thing, but the specific product didn't get selected. we need to do more research in how to make this work. when we pull from klaviyo, what information does it surface about the product? Also it has a shop now blue button that we didn't copy over. can we pull that information? are you able to see the button settings for product blocks?"

## Answers + root cause (from bundle)

**What Klaviyo surfaces about the product** (from the `kl-product` block in source):
- Product **name**: "AUTOBOAT SMART HEAD GPS Pro Anchor System - for 12V Minn Kota 30-55 Lb Trolling Motors or similar"
- **Price**: `$899.97`
- **Image URL**: `https://cdn.shopify.com/s/files/1/0364/6105/2039/files/autoboat-smart-head-gps-pro-anchor-system-...jpg`
- **Shopify product handle in the URL**: `…myshopify.com/products/autoboat-gps-trolling-motor-anchor-system` ← the deterministic selector
- **Per-product "Shop now" button**: `<a href="…/products/autoboat-…">Shop now</a>`, bg `#1155cc`, white text, padding 10px, border-radius 5px

**Why it didn't get selected:** mime emits `_pendingProducts` keyed on the **name** for the importer to resolve via Shopify name **search** (memory `project_products_block_mapping` + `project_coverage_gaps`). Name search is fuzzy and missed/over-matched this long product name → no/wrong selection. **The handle (`autoboat-gps-trolling-motor-anchor-system`) is a unique, deterministic Shopify identifier** — resolving by handle would pick the exact product.

## Proposed change

1. **Carry the Shopify handle.** In the product parser ([`src/parser/blocks/product.ts`](../../../src/parser/blocks/product.ts) / [`klaviyo-specific.ts`](../../../src/parser/blocks/klaviyo-specific.ts)), extract the handle from the product/button URL (`/products/<handle>`) and include it on `_pendingProducts` alongside the name.
2. **Resolve by handle first** in the importer (redoapp `import-klaviyo-templates.ts` `_pendingProducts` → `manuallySelectedProducts`): Shopify lookup by handle (exact) → fall back to name search only if no handle. This is the real fix for "product didn't get selected."
3. **Per-product button:** determine whether Redo's product block supports a per-product CTA button (text/color/link). **Check the Redo product-block schema** (redoapp `email-builder` Products block + MCP). If yes → carry the button (text "Shop now", bg `#1155cc`, the product URL). If no → surface a warning; the merchant adds it, OR emit a separate Button block after the product.

## Verify
- AutoBoat re-imported: the product block resolves to the exact AutoBoat product (via handle), with image/price; the "Shop now" button is present (or warned if unsupported).
- Regression: existing name-based resolution still works when no handle is present.

## Notes
- **Handle-based resolution is a general upgrade** to the whole `_pendingProducts` path — fold into the Products cluster (E) as the preferred resolver, extending [Charlie Task 2](../2026-05-26-charlie-1-horse/ac-product-block-dynamic-cart.md). It likely fixes the static-product misses across many merchants, not just Tiny Boat.
- The button question needs the Redo product-block schema confirmed before committing to carrying it — executor step 0.

## Done
(filled by executor)

## Executor triage 2026-06-25
DEFERRED — needs the static-product Shopify resolver (resolve by handle) +
carrying the product button. Bigger than a parser tweak; belongs with the
Products cluster (E) static-product work, not the quick TBN fidelity batch.

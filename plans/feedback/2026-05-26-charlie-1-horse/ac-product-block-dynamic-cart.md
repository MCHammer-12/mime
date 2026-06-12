---
status: blocked
branch: fix/ac-product-block-dynamic-cart
pr: null
---

# Abandoned Cart product block emits static image instead of dynamic cart-items

## Feedback (verbatim)

WgXbn6 + U3cE5u (Abandoned Cart Emails 1 + 2):

> Product image does not give room for individual cart selection — an image is showing not the abandoned cart.

i.e. the migrated emails show a generic product image where Klaviyo's email would show the customer's actual cart contents.

## Root cause

Per memory `project_products_block_mapping`: Klaviyo `kl-product` blocks should map to Redo's **interactive-cart** block (dynamic only for MVP). The default filter is **Best Sellers**, but for cart/AC emails it should be **Cart Item**.

Two things to verify:
1. Is the AC template's `kl-product` block being detected and emitting an interactive-cart block at all, or is it falling through to an image block? (Charlie 1 Horse's AC emails apparently use a Klaviyo product block, but the report says "an image is showing".)
2. If it IS emitting interactive-cart, is the filter defaulting to Best Sellers instead of Cart Item?

Relevant files:
- [`src/parser/blocks/product.ts`](src/parser/blocks/product.ts) — kl-product block parser
- [`src/parser/blocks/klaviyo-specific.ts`](src/parser/blocks/klaviyo-specific.ts) — Klaviyo-specific block handling
- [`src/parser/index.ts`](src/parser/index.ts) — dispatcher; check if AC trigger context propagates to product block parsing

The flow trigger gets resolved upstream (see `src/flow/trigger-mapping.ts`), so by the time we parse the AC email template attached to a `MARKETING_CART_ABANDONMENT` flow, we know it's a cart email. Question is whether the parser receives that context.

## Proposed change

1. Pull the AC source HTML (WgXbn6 or U3cE5u) via `/api/debug/resolve-template` or Klaviyo API.
2. Determine which case we're in:
   - **Case A: kl-product not detected** → image fallback. Fix the detection in `klaviyo-specific.ts` / `product.ts` to recognize Charlie's AC product-block shape.
   - **Case B: kl-product detected but defaulting to Best Sellers** → plumb the flow trigger (`MARKETING_CART_ABANDONMENT`) into `ParseContext`, and in `product.ts` choose `Cart Item` filter when the context indicates a cart/AC trigger.
3. Default mapping table for cart/AC:
   - Trigger `MARKETING_CART_ABANDONMENT` → product filter = `Cart Item`
   - Trigger `MARKETING_CHECKOUT_ABANDONMENT` → product filter = `Cart Item`
   - Trigger `MARKETING_BROWSE_ABANDONMENT` → product filter = `Viewed Product` (separate from this task — handled by Task 7)
   - Otherwise → `Best Sellers` (current default, keep as-is)
4. Update or add a smoke test under `src/parser/` that asserts a kl-product block under an AC trigger emits a Cart Item filter.

Wait until **Task 1 (universal duplication)** lands before merging — visual verification of "individual cart selection works now" is hard when the block is doubled.

## Verify

- AC email parse output contains an `interactive-cart` block with `filter: "Cart Item"` (or whatever the Redo schema names that filter)
- Re-import for Charlie 1 Horse: AC emails show cart contents in the Redo editor's preview when a test cart is loaded
- Smoke test passes on the saved Charlie HTML

## Notes

- Don't conflate this with the static-product → AI Shopify-name resolver (`_pendingProducts`) — that's for static product lists in non-AC contexts. This task is about dynamic cart-items, which is a different Redo block type.
- Browse Abandonment uses the same general kl-product detection but with a different filter (Viewed Product) and a different dynamic-variable shape — see Task 7 for the BA-specific work.

## Notes — executor investigation 2026-05-26

**Task premise doesn't match the parse output.** Re-investigated against
the current parser (with PRs #75, #76, #77 merged) and the raw source HTML
for WgXbn6 + U3cE5u (pulled live from Klaviyo).

**Findings:**

1. Neither Case A nor Case B applies. WgXbn6 + U3cE5u contain **no
   `kl-product` blocks at all**. Their abandoned-cart product display uses
   Klaviyo's "universal content block" pattern instead: a `<table>`
   wrapping `{% for item in event.extra.line_items %}` Liquid loop.
2. The parser **already handles this** via
   [`parseLineItemsUcbBlock`](../../../src/parser/blocks/product.ts) (called
   from the dispatcher in [`index.ts`](../../../src/parser/index.ts)). It
   correctly emits an `interactive-cart` block with:
   - `productSelectionType: "dynamic"`
   - `schemaFieldName: "cartContext"`
   - `_pendingFilter.name: "Cart Item"` (`productRecommendationType: "products_added_to_cart"`)
3. Confirmed identical, correct output for both WgXbn6 and U3cE5u. The
   warning `"Cart items UCB (event.extra.line_items loop) → Products
   block with Cart Item filter."` is fired exactly once per template.

**What might be the actual issue (Redo-side, not mime):**

- The bundle was captured 2026-05-21, BEFORE PRs #75 / #76 / #77. The
  pre-#75 parse output had the interactive-cart block duplicated
  alongside other blocks; possibly the second copy / mobile variant was
  the one the merchant saw as "static".
- Redo's editor may be rendering the interactive-cart with an empty
  placeholder when no cart fixture is loaded — the merchant could be
  interpreting an empty preview as "an image is showing".
- The importer side (`redo/manage/src/import-klaviyo-templates.ts`) may
  not be honoring `_pendingFilter` on the `interactive-cart` block —
  worth checking that the imported block actually carries the Cart Item
  filter when it lands in Redo's editor.

**Recommended next step:**

Re-import Charlie 1 Horse's AC emails NOW (post-#75/#76/#77 merge),
capture a fresh troubleshoot bundle, and check whether the merchant
still reports "static image". If yes → it's a Redo importer/editor
issue, not a mime parser issue. If no → the original complaint was the
duplication artifact and Task 1 already resolved it.

Marking `blocked` because the parser fix the planner described isn't
needed; the right move depends on what the post-merge re-import looks
like.

## Done

(filled by executor on completion)

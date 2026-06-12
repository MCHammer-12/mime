---
status: unclaimed
branch: fix/customer-winback-no-product-image
pr: null
---

# Customer Winback flow — no product image

## Feedback (verbatim)

Buttercup Lynne `Customer Winback - Standard` (X3Wwpd):

> There was no product image for this flow. Every other thing looks good

i.e. the only issue with this flow is missing product imagery — everything else migrated cleanly.

## Root cause

Customer Winback emails typically show "we miss you, here's some products you might like" — usually a row of personalized product recommendations. Two possibilities:

1. **Static product list in the Klaviyo template.** Merchant hand-picks 4 products to feature in a Winback email. mime's static-product flow needs to resolve product IDs to images via the merchant's Shopify catalog at import time (per memory `project_products_block_mapping` — `_pendingProducts` resolution in redoapp). If that resolution fails or isn't wired for the Winback context, images come out blank.
2. **Dynamic product block with a "best sellers" or "trending" filter.** Klaviyo has a Recommended Products block. mime should map this to Redo's interactive-cart with Best Sellers filter (the default per `project_products_block_mapping`).
3. **Image-only block (not a product block at all).** The "product image" is a regular `<img>` of a product, with the product ID referenced in the URL. If the URL is Klaviyo-CDN-hosted and expired, image 404s.

Customer Winback's trigger is typically `customer-last-active-N-days` or similar — schemaType depends on Redo's trigger mapping. Check the parse-result.json for the resolved trigger.

Relevant files:
- [`src/parser/blocks/product.ts`](src/parser/blocks/product.ts) — kl-product detection
- [`src/parser/blocks/klaviyo-specific.ts`](src/parser/blocks/klaviyo-specific.ts) — Recommended Products component
- [`src/parser/blocks/image.ts`](src/parser/blocks/image.ts) — fallback if it's plain image

## Proposed change

1. **Pull the Customer Winback email's source HTML** via Klaviyo API (key Michael provided this session — don't commit).
2. **Identify which case it is** (static, dynamic, plain image). The DOM around the product image tells you.
3. **Case A (static products):** trace the static product resolver path — `_pendingProducts` → redoapp `manuallySelectedProducts` via Shopify search. Confirm it's firing for Winback context. If the Winback trigger schemaType isn't on the "products-enabled" list in the importer, expand the list.
4. **Case B (dynamic / Recommended Products):** map to interactive-cart with appropriate filter. Winback context → Best Sellers is the safest default unless Redo has a "previously viewed by customer" filter for Winback triggers.
5. **Case C (plain image with expired Klaviyo URL):** lower priority — image was always a snapshot, the merchant could update the asset themselves. Surface as a `templateWarning` with the broken URL.

## Verify

- Re-import Buttercup Winback: emails show product images (either resolved static or dynamic placeholder)
- Smoke test for whichever case applies
- Regression check on other merchants' Winback flows (if any) and on the Charlie 1 Horse welcome flows that already use static products

## Notes

- Coordinate with Charlie Task 2 (AC product block — dynamic cart-items) and Charlie Task 7 (BA dynamic product). All three are variations of "Klaviyo's product block → Redo's product/cart block per trigger type". If those tasks land first, this one likely becomes a small extension (add Winback trigger to the supported list).
- Customer Winback isn't a documented memory yet — once this lands, worth a sentence in `project_products_block_mapping` noting the Winback default filter.

## Done

(filled by executor on completion)

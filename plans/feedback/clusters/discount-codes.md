---
status: unclaimed
branch: fix/discount-code-create-attach
pr: null
---

# Discount codes — create + attach a real Redo code at import

Scoped 2026-06-12 (Michael: "scope it now"). Recurs on welcome / promo flows
("Use the Code" buttons, "15% OFF", `{% coupon_code %}`). Cluster F on the board.

## What's already built (parse side)

[`src/parser/blocks/discount.ts`](../../../src/parser/blocks/discount.ts) detects standalone `{% coupon_code 'Name' %}` in a text block and splits it into `[text, discount, text]` blocks, transferring span font styling onto the discount block. Per memory `project_coupon_to_discount`: it emits a Redo discount block + (intended) an API object, with AI text rewrite around the coupon. Memory `project_image_as_button_conversion` covers the image-CTA variant.

So mime **recognizes** coupons and emits a discount block. The gap is downstream.

## Decisions (Michael, 2026-06-12) + redoapp findings

| Question | Answer | Grounding |
|----------|--------|-----------|
| What does the block bind to? | **A pre-created Redo discount — reference its `discountId`** (ObjectId). Create the discount, then bind the ID. | `email-builder.ts:141 discountId: string`; `email-template.ts:70,566 discountId: zExt.objectId().optional()` |
| Static code or per-recipient? | **Redo generates per-recipient.** mime creates the discount *config* only — no code to copy. | Redo "generated discount code" system: MCP `get_generated_discount_code`; `redo/marketing/manage/src/{test,backfill}-generated-discount-code*.ts` |
| Where do amount + type come from? | **Fetch from the Klaviyo API** (coupon definition), not operator input. | mime does NOT extract coupons today — new work (below) |

Redo discount model is `redo/model/src/discount.ts`: `DiscountValueType` = `PERCENTAGE` \| `AMOUNT` (maps Klaviyo % vs fixed), plus `DiscountType` (ORDER / FREE_SHIPPING / PRODUCT / BUY_X_GET_Y), expiration, min-requirement.

**Executor step 0 — confirm the merchant-facing create-discount RPC.** The grep found the model + service utils (`lookup-discount-reference.ts`, the manage scripts) but not a clean merchant RPC handler. Find it (or confirm it's a redoapp dependency, same pattern as segment Task 4's add-members RPC). Use MCP `get_discount_config` on a hand-built discount email to see the live shape.

## New extraction work — Klaviyo coupon definitions

Amount + type live in Klaviyo's **coupon** objects, not the template HTML. mime's extractors (`src/klaviyo.ts`, `src/extract-*.ts`) don't fetch them today. Add a Klaviyo coupons API pull (`GET /api/coupons` / coupon-codes), keyed by the coupon **name** the template references.

**Gotcha:** `discount.ts buildDiscountBlock` currently **discards** the coupon name (`_couponName`, unused — confirmed in code). It must be **carried on the DiscountBlock** (e.g. a `_pendingCoupon: { name }` marker, like `_pendingProducts` / `_pendingFilter`) so the import path can look up its amount/type via the Klaviyo coupons API and create the Redo discount.

## Proposed change

1. **Carry the coupon name.** `discount.ts` → stop dropping `_couponName`; emit a `_pendingCoupon` marker on the DiscountBlock.
2. **Extract Klaviyo coupons.** New `src/extract-coupons.ts` (or fold into existing extract) → fetch coupon definitions (value, value-type, expiration) keyed by name.
3. **Create the Redo discount at import.** In `import-rpc.ts`, for each `_pendingCoupon`: map Klaviyo value/type → `DiscountValueType` + value, call the create-discount RPC (once confirmed), get the `discountId`, set it on the block. Redo handles per-recipient code generation.
4. **Dedup** per coupon name / (value, type) so one Redo discount serves N templates.
5. **SMS** discount placeholders bind the same `discountId` path.
6. **Interim if the create-discount RPC isn't ready:** keep the current placeholder block + a precise warning naming the coupon + amount (now that we fetch it) so the operator finishes it. No silent empty discount.
7. **Coordinate with the "copy mismatch" flag** (Roden Gray Task 2): the AI rewrite around `{% coupon_code %}` is the prime suspect for altered copy — keep the rewrite scoped to the coupon token, not surrounding sentences. Verify together.

## Verify

- A welcome flow with a `{% coupon_code %}` re-imports → the Redo email has a discount block bound to a real, working Redo code (prefix/amount as the operator specified).
- "Use the Code" button (Roden Gray U7F7DL) renders with the code/link, not dropped.
- SMS discount placeholder binds the same way.
- Dedup: N templates, one discount.
- No-RPC interim path: clear preflight warning, block emitted with placeholder, import doesn't fail.
- AI rewrite leaves non-coupon copy unchanged (ties to RG Task 2).

## Notes

- **Likely cross-repo** (redoapp create-discount RPC + mime consumer), same pattern as segment Task 4. The two share a theme: import-time creation of merchant objects (segments, discounts) that Klaviyo managed externally.
- This unblocks a large class — nearly every welcome/promo flow has a coupon. High recurrence, currently shipping placeholders.
- Don't rebuild the parse side; `discount.ts` is done. This is purely the create+attach+bind at import.

## Done

(filled by executor on completion)

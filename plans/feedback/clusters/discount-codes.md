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

## The gap (import side) — the actual work

Per memory `project_discount_codes_open_question`: a migrated discount block references a code that **doesn't exist in Redo**. Klaviyo's `{% coupon_code %}` renders a per-recipient code from a Klaviyo-managed pool; Redo has its own discount/code system. mime can't just copy the Klaviyo code — it needs Redo to **create a discount + generate/attach a code at import time**, then point the block at it. This blocks both email and SMS discount UX (user confirmed 2026-05-06).

Two unknowns to resolve first:
1. **Does a merchant-facing Redo RPC exist to create a discount + code?** Same shape of question as the segment RPC (Task 4) — check `redo/merchant/**/rpc` for create-discount / generate-code. The Redo MCP has `get_discount_config` + `get_generated_discount_code` (read side) — use them + redoapp source to find the write side. If no merchant create-discount RPC exists, this is a redoapp dependency (like segment add-members).
2. **What does the discount block need to render?** A discount id? A static code string? A dynamic-code reference? Confirm the Redo discount-block schema + how it binds to a code (via MCP `get_discount_config` on a hand-built discount email, or redoapp `email-builder` discount block).

## Inputs required from the merchant (per memory `project_coupon_to_discount`)

A Klaviyo coupon doesn't carry enough to recreate the Redo discount:
- **Prefix** (default "RE" per memory `project_migration_human_input_ux`)
- **Amount + type** (% vs fixed) — Klaviyo's coupon definition may not be in the template HTML; needs the Klaviyo coupon/promotion API or operator input.
- These are human-input touchpoints — surface in the import preflight (the `choice`/`text` prompt infra already exists, used by fonts + triggers).

## Proposed change

1. **Resolve the two unknowns** (RPC existence + block binding shape). If the create-discount RPC is missing → file the redoapp dependency, ship an interim (emit the discount block with a placeholder + a precise "create this discount in Redo" warning, the current behavior).
2. **If the RPC exists:**
   - At import (`import-rpc.ts`), for each emitted discount block: create the Redo discount (prefix + amount + type from preflight input), generate/attach a code, bind the block to it.
   - Dedup per (prefix, amount, type) so one Redo discount serves N templates in a batch (like segment dedup).
   - Preflight-prompt for prefix/amount/type once per distinct coupon.
3. **Apply the same binding to SMS** discount placeholders (the SMS path emits `{% coupon_code %}` too).
4. **Coordinate with the "copy mismatch" flag** (Roden Gray Task 2): the AI rewrite around `{% coupon_code %}` is a prime suspect for altered copy — keep the rewrite scoped to the coupon token, not surrounding sentences. Verify together.

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

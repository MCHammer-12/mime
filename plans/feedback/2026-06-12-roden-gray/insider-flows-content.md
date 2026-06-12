---
status: unclaimed
branch: fix/rg-insider-flows-content
pr: null
---

# Insider flows — center-align/font-size, "Use the Code" button, static product, footer dropped + copy mismatch

## Feedback (verbatim)

Roden Gray `new insider` (U7F7DL) — and `Garmentory_Insider10` (Wv6dVS): "Same feedback as the new insider flow."

> The text formatting was not migrated correctly. For this email, the text should be center-aligned and use the same font sizing as the original version. The email copy also does not match the original and needs to be updated. The "Use the Code" button was not migrated, nor was the static product block. The footer is missing as well and was not carried over during the migration.

Both imported clean (`createdTemplateCount: 1`, **zero warnings**) — so the parser thought it succeeded, but multiple elements are wrong/missing. Silent.

## Root cause

Five sub-issues, two flows, same template family. Each needs source HTML (klaviyo-flow.json in bundle; template HTML via resolver/API, key from Michael).

1. **Text not center-aligned + wrong font sizing.** Inline `text-align: center` and font-size lost during text-block parse. Files: [`src/parser/blocks/text.ts`](../../../src/parser/blocks/text.ts), [`src/parser/style-utils.ts`](../../../src/parser/style-utils.ts). Alignment is read from inline style or parent `<td align>` — check both.
2. **"Use the Code" button not migrated.** A discount-code CTA button dropped. This is a "15% OFF / Use the Code" insider email — the button likely carries the coupon code or a `{% coupon_code %}` (memory `project_coupon_to_discount`). Determine if the button is dropped at parse or mangled by the coupon→discount handling. Files: [`src/parser/blocks/button.ts`](../../../src/parser/blocks/button.ts), [`src/parser/blocks/discount.ts`](../../../src/parser/blocks/discount.ts).
3. **Static product block not migrated.** Hand-picked products dropped. Collapses partly to [Charlie Task 2](../2026-05-26-charlie-1-horse/ac-product-block-dynamic-cart.md) (dynamic) — but "static product block" is the `_pendingProducts` Shopify-resolve path (memory `project_products_block_mapping`). Confirm whether the static-product emit fired at all here.
4. **Footer missing.** Same footer theme as Customer Thank You Task 1 + Tiny Boat Task 3.
5. **Copy does not match the original — FLAG.** The actual text content differs from the Klaviyo source, not just formatting. **Diagnose before assuming.** Candidates:
   - The inline-coupon **AI rewrite** (memory `project_coupon_to_discount`: `{% coupon_code %}` → AI text rewrite + discount block) altered the surrounding copy more than intended.
   - Wrong template resolved (placeholder → wrong `_id`).
   - A dynamic/personalized text block rendered with placeholder/fallback copy.
   This is the most concerning item — wrong copy shipping silently. Pin the cause from the source-vs-output diff first.

## Proposed change

Investigation-first. Fetch U7F7DL's email source, diff against the migrated output element-by-element (like the Castle post-purchase investigation did). Then:
1. Alignment + font-size: fix the text-block style extraction.
2. "Use the Code" button: restore it; if it's coupon-driven, ensure discount/coupon handling emits the button rather than swallowing it.
3. Static product: confirm `_pendingProducts` path; fix detection if it didn't fire.
4. Footer: align with the cross-merchant footer fix.
5. **Copy mismatch: root-cause first.** If AI-rewrite is altering copy, scope the rewrite tighter (only the coupon token, not surrounding sentences). If wrong-template, fix the placeholder resolution. Don't patch symptoms.

Verify against **both** U7F7DL and Wv6dVS.

## Verify

- U7F7DL + Wv6dVS re-parsed + viewed: text center-aligned with correct sizing; "Use the Code" button present (with the right code/link); static product block present; footer present; **copy matches the Klaviyo source.**
- Regression: coupon/discount emails on other merchants unaffected; batch-test.

## Notes

- **Zero warnings despite 5 broken things** is itself a signal — the parser is silently succeeding on content it's actually dropping. Where a block is dropped (button, static product, footer), it should at minimum warn. Consider adding warnings as part of the fix so the next bundle surfaces these instead of looking clean.
- The copy-mismatch + coupon-button combination points at the coupon/discount + AI-rewrite path as a likely common cause for issues 2 and 5. Investigate them together.
- **Check `editor_type`** — if CODE, collapses to the CODE-fidelity batch.

## Done

(filled by executor on completion)

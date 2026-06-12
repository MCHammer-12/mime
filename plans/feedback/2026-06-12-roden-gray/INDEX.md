# Roden Gray feedback — 2026-06-12

Source: troubleshoot bundle `troubleshoot-roden-gray-kuhz-2026-06-09T02-12-55-501Z.zip`
Job: `9182e18c-7390-4f2e-80d4-8701fe9dee79` (roden-gray-kuhz)
Items: 5 flows (all imported OK; content + tags + condition feedback)

## Tasks (Roden Gray-specific)

| # | Status | Task | Branch | PR |
|---|--------|------|--------|----|
| 1 | unclaimed | [Customer Thank You — footer, right-side logo, dynamic blocks, value-table dropped](customer-thank-you-content.md) | `fix/rg-customer-thank-you-content` | — |
| 2 | unclaimed | [Insider flows — center-align/font-size, "Use the Code" button, static product, footer dropped + copy mismatch](insider-flows-content.md) | `fix/rg-insider-flows-content` | — |

## Collapsed into other batches / already fixed

| Issue | Flow(s) | Owning task |
|-------|---------|-------------|
| Tags not migrated | XV2iN3, HtR8MH | [Tiny Boat Task 2 (tag-list-actions-to-redo-steps)](../2026-06-12-tiny-boat-nation/tag-list-actions-to-redo-steps.md) — HtR8MH's whole purpose is tagging via `update-profile` (currently dropped; Redo's `manage_customer_tags` is the target) |
| "$500 added to cart" condition can't be recreated | XV2iN3 | Value-condition family — [ad-hoc #110 (cart-value-condition)](../2026-05-26-ad-hoc/cart-value-condition-mistranslated.md) handled profile-metric value; this is a **trigger-split `$value`** on cart-abandonment. Verify #110 covers it; if the trigger-split path still drops it, that's a follow-up to #110 (note it there). |
| `Shopify Tags contains X` / `Collections` branch conditions | XV2iN3, HtR8MH | [Tiny Boat Task 1 (#116, done)](../2026-06-12-tiny-boat-nation/branch-conditions-dropped.md) handled `contains` mechanism (viewed_items). These are new properties (Shopify Tags, Collections) — verify #116's approach extends; if the property isn't mapped, small follow-up. |
| Dynamic / product blocks not migrated | XV2iN3, LdGN2u | [Charlie Task 2 (ac-product-block-dynamic-cart)](../2026-05-26-charlie-1-horse/ac-product-block-dynamic-cart.md) |
| Text fonts need adjusting | XV2iN3 | Cross-merchant font (Charlie 4 / Blackline / font-mapping #111) |
| reentry_criteria, profile-not-in-flow | XV2iN3 | Charlie Task 8/9 family |

## Cross-cutting notes

**Wv6dVS = U7F7DL.** Reviewer: "Same feedback as the new insider flow." Both covered by Task 2; verify the fix against both (U7F7DL `email_signup`, Wv6dVS `customer_group_entered` — different triggers, likely same template family).

**"Copy does not match the original" (U7F7DL) is a flag.** Not just formatting — the actual text content differs. Could be the inline-coupon AI rewrite (memory `project_coupon_to_discount`) altering copy on a "15% OFF / Use the Code" email, or a wrong-template resolve. Task 2 calls it out as a distinct sub-issue to diagnose, not assume.

**Klaviyo source bundled** — every flow folder has `klaviyo-flow.json`.

**Flow IDs + triggers:**
- XV2iN3 — Abandon Checkout 2025 — `cart_abandoned` (tags/value/contains/products/fonts — all collapsed)
- HtR8MH — Tag Product Category Interest — `order_created` (tagging flow, 0 emails → Tiny Boat 2)
- LdGN2u — Customer Thank You — `order_created` (Task 1)
- U7F7DL — new insider — `email_signup` (Task 2)
- Wv6dVS — Garmentory_Insider10 — `customer_group_entered` (Task 2, same as U7F7DL)

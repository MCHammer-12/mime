# RUFSKIN feedback — 2026-06-12

Source: troubleshoot bundle `troubleshoot-rufskin-2026-06-12T11-14-55-428Z.zip`
Job: `67c1c95b-1d08-4d6d-a1d1-a437d457dffd` (storeId from manifest)
Items: 4 flows (3 feedback + 1 hard failure)

## Tasks (Rufskin-specific)

| # | Status | Task | Branch | PR |
|---|--------|------|--------|----|
| 1 | done | [Survey/custom-event metric mis-resolved + trigger_filter not migrated](survey-metric-trigger-filter.md) | `fix/survey-metric-trigger-filter` | [#124](https://github.com/MCHammer-12/mime/pull/124) |
| 2 | unclaimed | [Welcome Series — "SHOP NOW" text link dropped + text formatting distorted](welcome-shop-now-link-formatting.md) | `fix/welcome-shop-now-link-formatting` | — |

## ~~Needs Michael's decision~~ → RESOLVED (PR #122)

**HseqBM "Abandoned Cart" — trigger mapping conflict.** Reviewer:
> the flow trigger was migrated incorrectly. Redo created it as an Abandoned Cart flow when the original Klaviyo flow was actually triggered by Started Checkout.

**Resolved 2026-06-12 — the reviewer was right.** Michael reversed PR [#43](https://github.com/MCHammer-12/mime/pull/43): Klaviyo "Started Checkout" → Redo **Checkout Abandonment** (`MARKETING_CHECKOUT_ABANDONMENT`), shipped in PR [#122](https://github.com/MCHammer-12/mime/pull/122) ([ad-hoc Task 5](../2026-05-26-ad-hoc/started-checkout-to-checkout-abandonment.md)). HseqBM will now import as Checkout Abandonment on re-import. `added to cart` stays cart abandonment.

## Collapsed into other batches

| Issue | Affected flow | Owning task |
|-------|---------------|-------------|
| "Happy Birthday Email" import FAILED (date trigger, 400) | HFqsSH | [ad-hoc Task 3 (date-predictive-trigger-failure)](../2026-05-26-ad-hoc/date-predictive-trigger-failure.md) — **2nd merchant; Rufskin is the birthday case the fix directly unblocks** |
| Fonts not migrated / text formatting distorted | H8K2Tu, HseqBM | Cross-merchant font pattern (Charlie Task 4 / Blackline / ad-hoc font-mapping #111). Note: formatting distortion specifically is Rufskin Task 2 (may be more than fonts). |
| Dynamic product block not migrated (cart context) | HseqBM | [Charlie Task 2 (ac-product-block-dynamic-cart)](../2026-05-26-charlie-1-horse/ac-product-block-dynamic-cart.md) |
| Social media links didn't clone correctly | Y7HwZ3 | Cross-merchant socials (Castle `socials-block-missing` #90 [done] / Buttercup `socials-wrong-colors`). Verify #90's fix covers Rufskin; if links specifically (not icons) are the issue, fold into Rufskin Task 1's social note. |

## Cross-cutting notes

**Klaviyo source bundled.** Each flow folder has `klaviyo-flow.json` — executors can read the real Klaviyo flow definition directly from the bundle (no API key needed for structure; may still need key for template HTML).

**Flow IDs + triggers (from parse-results):**
- H8K2Tu — Welcome Series — `email_signup` (Task 2 + font/formatting)
- Y7HwZ3 — SURVEY COMPLETED (GV support) — now → null (skip → trigger picker), no longer `order_fulfilled` (Task 1 done #124); trigger_filter `survey_code equals 689d034ddda30` surfaced by name
- HseqBM — Abandoned Cart — Started Checkout → **Checkout Abandonment** as of #122 (was `cart_abandoned`); fonts + dynamic product collapsed
- HFqsSH — Happy Birthday Email - Standard — `date`/`marketing_date` — **FAILED** (ad-hoc Task 3)

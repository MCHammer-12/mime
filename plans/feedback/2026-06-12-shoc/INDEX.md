# SHOC feedback — 2026-06-12 (STALE bundle, pre-fixes)

Source: troubleshoot bundle `troubleshoot-SHOC-2026-05-21T22-50-50-705Z (2).zip`
Job: `b359c92b-db27-4905-94d6-d58a50c82723` (SHOC)
Items: 5 flows

## ⚠️ This bundle predates several merged fixes — re-import first

The bundle was captured **2026-05-21**, before these landed. Most of the flagged issues are already fixed; re-importing SHOC should clear them. Verify before doing any new work:

| Reviewer complaint | Flow | Fixed by | Status |
|--------------------|------|----------|--------|
| "added to cart **more than 74 times**" instead of "value > 74 in last 30 days" | XH5SFA | [ad-hoc #110 (cart-value-condition)](../2026-05-26-ad-hoc/cart-value-condition-mistranslated.md) | **merged** — SHOC literally motivated this fix |
| "conditioner split wrote **1 day** instead of 3 days" | REw7SL | [#68 (tf.quantity not tf.value)](https://github.com/MCHammer-12/mime/pull/68) | **merged** — SHOC surfaced this too |
| "conditioner split incomplete" (back-in-stock) | SwZcfV | [Tiny Boat #116 (branch-conditions)](../2026-06-12-tiny-boat-nation/branch-conditions-dropped.md) | **merged** — but SwZcfV's is list-membership, see Task 1 |
| font name/size not indicated (all flows) | all | [font-mapping #111](../2026-05-26-ad-hoc/font-name-mismatch-mapping.md) + Charlie 4 | merged/in-flight |

**Action: re-run the SHOC import on current `main`, capture a fresh bundle, and only then triage what remains.** Everything below is what's likely left after re-import.

## Tasks (SHOC-specific)

| # | Status | Task | Branch | PR |
|---|--------|------|--------|----|
| 1 | unclaimed | [Klaviyo list-membership condition (`profile-group-membership`) dropped](list-membership-condition.md) | `fix/shoc-list-membership-condition` | — |

## Collapsed / verify-after-reimport

| Issue | Flow(s) | Owning task |
|-------|---------|-------------|
| Product images not arranged / missing | XH5SFA, R3uzmb, SwZcfV, VyrXvY (email 3) | [Charlie Task 2](../2026-05-26-charlie-1-horse/ac-product-block-dynamic-cart.md) (dynamic) / products |
| Button link not correct (back-in-stock) | SwZcfV | [Charlie image-clickthrough / inline-anchor](../2026-05-26-charlie-1-horse/image-clickthrough-links.md) family — verify with current build |
| Font name/size after header | all | font-mapping #111 + Charlie 4 |
| `event.URL` unmapped token (SMS) | XH5SFA, R3uzmb | Known — checkout-URL handling (memory `project_redo_checkout_url_resolution`); verify current build rewrites it |
| WAIT weekday/time-of-day restriction lost | REw7SL | Known degraded-mapping (Redo WAIT has no weekday/time-of-day field). Not yet a task — if merchants care, file a "WAIT scheduling fidelity" task. |

## Cross-cutting notes

**Older bundle format** — these folders have `parse-result.json` + `notes.md` but **no `klaviyo-flow.json`** (pre-dates source-snapshot bundling). A re-import on current build will produce a richer bundle with source included.

**Flow IDs:**
- XH5SFA — Abandoned Cart (Shopify Added to Cart) — `cart_abandoned` (value-condition FIXED #110)
- VyrXvY — [OCC] Welcome | Pop Up New User — `email_signup` (email-3 images + fonts)
- R3uzmb — Abandoned Checkout (Shopify Started Checkout) — `cart_abandoned` (per design, Started Checkout → cart abandonment)
- SwZcfV — Back In Stock - Standard — `back_in_stock` (list-membership condition = Task 1; product image + button link)
- REw7SL — Welcome Flow 15% OFF — `email_signup` (timeframe FIXED #68; weekday-wait degraded)

# Fairechild feedback — 2026-05-26

Source: troubleshoot bundle `troubleshoot-fairechild-2026-05-12T16-27-53-223Z.zip`
Job: `3f8d9c62-5b84-493e-aeca-0caf23f882fb` (storeId `mcht/6977a2634559f59ffd56c902`)
Items: 1 flow flagged (Review Request — Email & SMS, 4 emails)

## Tasks (Fairechild-specific)

| # | Status | Task | Branch | PR |
|---|--------|------|--------|----|
| 1 | unclaimed | [Product rating blocks missing in Review Request emails](product-rating-blocks-missing.md) | `fix/product-rating-blocks-missing` | — |

## Collapsed into other batches

| Issue | Owning task |
|-------|-------------|
| "Some of the emails did not have the right font or it was not included" | [Charlie Task 4 (first-text-font-styling)](../2026-05-26-charlie-1-horse/first-text-font-styling.md) — **done per git log**, may already cover; verify ▸ [Blackline (font-rendering-inconsistent)](../2026-05-26-blackline-car-care/font-rendering-inconsistent.md) ▸ [GPA Task 2 (welcome-series-image-fonts)](../2026-05-26-gay-pride-apparel/welcome-series-image-fonts.md) |

The font issue is now reported across **4 merchants** (Charlie, Blackline, GPA, Fairechild). Each surfaces a bit differently:
- Charlie: missing font families in brand kit
- Blackline: editor font rendering inconsistent
- GPA: image overlay text fonts
- Fairechild: "not the right font or not included" (close to Charlie's symptom)

Executors for Blackline / GPA Task 2 should add Fairechild to their verification set. If Charlie Task 4's fix already handles this, the cross-link can be marked resolved.

## Cross-cutting notes

**Klaviyo API key provided by Michael** — executor can fetch source HTML / template content. Don't write the key into any file or commit it.

**Fairechild contact info:**
- `organization.name` → `fairechild`
- storeId: `mcht/6977a2634559f59ffd56c902`

**Flow ID:** `Ud4pqF` — Review Request Klaviyo (Email & SMS), Klaviyo status: disabled. Trigger: `order_delivered` (schemaType `order_tracking`). 4 email steps + 1 ab_test split (Variant A/B at 50/50).

**Prior Fairechild work** (context only — not in this bundle):
- PR #59: added 15 Order Tracking triggers + generic `review_submitted` to picker. Fairechild's prior bundle hit the "Ready to review" Klaviyo metric not in `METRIC_NAME_MAP` — operator picked manually. This bundle uses `order_delivered` which auto-resolves, so trigger picker isn't a factor here.

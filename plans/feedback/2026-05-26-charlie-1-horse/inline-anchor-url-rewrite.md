---
status: done
branch: fix/inline-anchor-url-rewrite
pr: https://github.com/MCHammer-12/mime/pull/77
---

# Inline anchor in text block retains Klaviyo checkout URL

## Feedback (verbatim)

WgXbn6 + U3cE5u (Abandoned Cart Emails 1 + 2):

> Second text: ... 2) The 'complete the purchase' link in the text does not match the right link on Redo (has the Klaviyo link)

i.e. the AC email body has phrasing like _"click here to complete the purchase"_ with an inline `<a href="{{ event.extra.responsive_checkout_url }}">` (or one of the 4 Klaviyo checkout variables). The button block correctly rewrites to `<storeUrl>/cart`, but the **inline anchor in a text block** does not.

## Root cause

Per memory `project_redo_checkout_url_resolution` + PR #43, the URL rewrite logic in [`src/parser/url-mapping.ts`](src/parser/url-mapping.ts) replaces Klaviyo's four checkout-URL variables with `<storeUrl>/cart`. This is called from [`src/parser/blocks/button.ts`](src/parser/blocks/button.ts) and [`src/parser/blocks/image.ts`](src/parser/blocks/image.ts) — but **not from the text block parser**.

Charlie 1 Horse's AC email has prose with inline `<a>` tags pointing at Klaviyo variables. The text block parser ([`src/parser/blocks/text.ts`](src/parser/blocks/text.ts)) emits the text content as HTML/structured content but doesn't run inline anchor `href` values through `mapKlaviyoLink`.

## Proposed change

1. In [`src/parser/blocks/text.ts`](src/parser/blocks/text.ts), walk the parsed text HTML for `<a href="…">` tags and run each `href` through `mapKlaviyoLink` from `url-mapping.ts`. Use the same `ParseContext` (specifically `storeUrl`) that buttons + images already use.
2. Apply to all four Klaviyo checkout variables: `event.URL`, `event.CheckoutURL`, `event.extra.checkout_url`, `event.extra.responsive_checkout_url`. The existing `url-mapping` already handles them — text just needs to call into it.
3. For unsupported variables in text anchors (anything outside the known mapping table), follow the same reviewItem pattern that buttons use — emit a reviewItem and leave the original href.

Don't change `mapKlaviyoLink` itself or the static-vs-dynamic mapping logic. Just call it from the text path.

## Verify

- Charlie 1 Horse AC email re-parsed: inline "complete the purchase" link → `<storeUrl>/cart` (currently `http://www.charlie1horsehats.com/cart`)
- Smoke test (extend [`src/parser/url-mapping.smoke.ts`](src/parser/url-mapping.smoke.ts) or add a text-block smoke) covers text-with-anchor case
- Other text content (non-link prose, non-Klaviyo-variable links) unchanged

## Notes

- Footer text already substitutes `{% unsubscribe %}` etc. via a different path (per memory `project_klaviyo_footer_variables`) — don't disturb that. This is specifically about `<a href>` values in body text blocks.
- If text blocks are running through AI rewrites for inline coupons (see memory `project_coupon_to_discount`), make sure the anchor-rewrite happens BEFORE the AI pass so the AI sees the Redo URL, not the Klaviyo one.

## Done

- PR: https://github.com/MCHammer-12/mime/pull/77
- Confirmed root cause exactly as written: text-block inline `<a href>` was
  the only Klaviyo-variable carrier that didn't run through
  [`classifyKlaviyoUrl`](../../../src/parser/url-mapping.ts) (button + image
  already do). Charlie 1 Horse WgXbn6/U3cE5u both have
  `<a href="{{ event.extra.checkout_url }}">complete your purchase.</a>`
  inside the second text block.
- Fix shape:
  - Added `rewriteAnchorHrefs` in
    [`src/parser/blocks/text.ts`](../../../src/parser/blocks/text.ts) that
    walks every `<a href="...">` (or `<a href='...'>`) in the text HTML
    and runs Klaviyo-variable hrefs through the existing mapper.
  - Slotted in **before** `suppressUrlAutolink` so any future downstream
    AI / coupon rewrite sees the final Redo URL, not the Klaviyo variable.
  - Renamed `_ctx` → `ctx` in `parseTextBlock` since the context is now used.
- Verification:
  - WgXbn6 + U3cE5u with `storeUrl="http://www.charlie1horsehats.com"`:
    both "complete your purchase" anchors resolve to
    `http://www.charlie1horsehats.com/cart`. No reviewItems pushed (clean
    rewrite). Without storeUrl: variable preserved, 2 reviewItems pushed
    — matches button/image behavior.
  - [`text.smoke.ts`](../../../src/parser/blocks/text.smoke.ts) extended
    with 6 new cases: all four Klaviyo checkout variables, unsupported
    variables (reviewItem), static URL passthrough, single-quoted href,
    no-storeUrl behavior. All assertions pass.
  - batch-test on 416-template corpus: 0 failures, identical clean/warned.
- **Not in scope (deferred):**
  - Footer-variable resolution (`{% unsubscribe %}` etc.) is handled via a
    different path (per memory `project_klaviyo_footer_variables`); this
    PR doesn't touch it.
  - AI pass for inline coupons (memory `project_coupon_to_discount`) isn't
    wired into the text pipeline yet; once it is, the anchor rewrite needs
    to stay before it — comment in the pipeline call site spells this out.

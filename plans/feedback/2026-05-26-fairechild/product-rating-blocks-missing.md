---
status: unclaimed
branch: fix/product-rating-blocks-missing
pr: null
---

# Product rating blocks missing in Review Request emails

## Feedback (verbatim)

Fairechild Review Request Klaviyo flow (Ud4pqF):

> The flows came out good. However, the product ratings were missing in all the emails ...

i.e. Klaviyo's review-request emails contain a "rate your purchase" component (typically a row of 5 star buttons each linking to the merchant's review platform — Yotpo, Stamped, Judge.me, etc., with the rating pre-filled in the URL). All 4 migrated Fairechild emails came out without these rating widgets.

## Root cause

Klaviyo's Reviews app emits review-request emails with a specific block type — usually a row of star icons or numbered rating buttons, each as an `<a>` wrapping a star image with a URL like `https://app.yotpo.com/reviews/new?rating=5&...`. mime currently doesn't recognize this block type and likely drops it (or emits warnings).

Possible patterns in the source HTML:
- Inline `<table>` row with 5 `<td>` cells, each containing a clickable star image
- A custom Klaviyo block type for "review rating" specifically  
- A repeating component-wrapper with a star icon and a rating-specific URL

Likely files:
- [`src/parser/blocks/klaviyo-specific.ts`](src/parser/blocks/klaviyo-specific.ts) — Klaviyo-specific block patterns (the right place for a new review-rating block parser)
- [`src/parser/index.ts`](src/parser/index.ts) — dispatcher; needs to route the rating block to its parser
- [`src/parser/blocks/column.ts`](src/parser/blocks/column.ts) — if the rating uses a column layout, may incorrectly emit as a generic 5-column block (the stars would still be there but as 5 disconnected image blocks — verify)

Redo equivalent:
- Redo's `order_tracking` schema may or may not have a dedicated review-rating block. Need to check. If not:
  - Emit as 5 separate button blocks with their respective review URLs (works but visually noisy)
  - OR emit as a single text block with 5 emojis/icons + links inline
  - OR surface as `unsupportedFeatures` with a clear warning so operator knows to manually add via Redo's editor

## Proposed change

1. **Pull source HTML for at least one Fairechild Review Request email.** Use the Klaviyo API key Michael provided this session (don't commit it). The 4 placeholder template IDs in the parse-result are `__PLACEHOLDER_RdufyP__`, `__PLACEHOLDER_TrqqPb__`, `__PLACEHOLDER_RGrhzn__`, `__PLACEHOLDER_S5UzaJ__` — look up the actual Klaviyo template IDs from the source flow JSON, then fetch.
2. **Identify the review-rating block pattern.** Inspect the DOM in the source HTML. Note the structure (table row, component-wrapper, etc.), the star image URLs, the rating URL format. Document in this task file.
3. **Check Redo's order_tracking schema.** Look in redoapp for whether `marketing_order_tracking` or similar exposes a "review rating" block type. If it does, map to that. If not, decide between the fallback options (separate buttons, text block, or unsupported warning).
4. **Write the parser.** New block parser for the rating widget, wired into the dispatcher.
5. **Smoke test.** Add a test under [`src/parser/blocks/`](src/parser/blocks/) (or wherever klaviyo-specific tests live) covering a synthetic review-rating block → expected Redo output.

## Verify

- Re-import Fairechild Review Request flow: emails contain a rating widget (or its agreed fallback) at the right position
- The rating URLs preserve the rating value (1-5) so clicking a star sends the correct rating to the merchant's review platform
- Smoke test passes
- Other merchants with review-request flows (any in `migrations/test-account/`?) don't regress — check via batch-test

## Notes

- Reviews app coverage is generally weak in mime. Per CONTEXT.md "open items": "Yotpo metric-name aliases need verification against Gaidama" — there's prior work in the area. Check that the executor for this task doesn't duplicate effort.
- The 4 emails are likely cascading review requests (10-day, 20-day Variant A; 15-day, 30-day Variant B). They likely all use the same rating block pattern — fix once, applies to all.
- This flow uses an `ab_test` step (Variant A vs B). Per memory `feedback_drop_unsupported_actions`, ab-test → extract `main_action.data` as send-email. The parse-result shows the ab_test was preserved with both variants intact (not collapsed). Confirm this is the current behavior — the merchant didn't flag the A/B as a problem, but worth noting.
- Don't conflate with the "ratings widget" some merchants embed via a 3rd-party iframe. This is Klaviyo's built-in pattern, not an iframe.

## Done

(filled by executor on completion)

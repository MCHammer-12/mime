---
status: done
branch: fix/video-to-image-clickthrough
pr: pending
---

# Klaviyo video block → Image block with thumbnail + video URL clickthrough

## Feedback (verbatim)

Tiny Boat (AutoBoat), Michael: "in this email they have a video block, which we just emitted [skipped]. are we able to just pull the thumbnail picture and the video url link as a clickthrough url?"

**Yes.** Currently skipped; the source has everything needed.

## Root cause / current behavior

`klaviyo-specific.ts:38` skips `kl-video` with `reason: "Klaviyo video block — not supported in Redo"` (memory `project_klaviyo_blocks_not_in_redo`). But a `kl-video` block is just a thumbnail image wrapped in a link:
```html
<td class="kl-video">…<a class="kl-img-link" href="https://youtu.be/dpJBQQ9fIi0…">
  <img alt="AutoBoat In Action" src="https://…/2f50fee9-…png" width="600"/></a>…
```
So it's structurally an image-with-clickthrough — exactly what Redo's Image block supports.

## Proposed change

In [`klaviyo-specific.ts`](../../../src/parser/blocks/klaviyo-specific.ts), stop skipping `kl-video`. Instead emit an **Image block**: `src` = the thumbnail `<img>` src, `clickthroughUrl`/link = the wrapping `<a href>` (run through `mapKlaviyoLink` for consistency, though external video URLs pass through). Reuse the existing image-block builder ([`image.ts`](../../../src/parser/blocks/image.ts)) — a video wrapper is an image+anchor, so route it there rather than duplicating logic.

Keep a `degraded-mapping` warning noting it was a video → static thumbnail+link (the merchant may want a real play affordance), but it's no longer dropped.

## Verify

- AutoBoat re-parsed: the video becomes an Image block with the youtu.be URL as clickthrough; no longer in `skippedBlocks`.
- Regression: non-video images unaffected; the preview-quote skip (klaviyo-specific.ts:46) stays skipped.

## Notes
- Memory `project_klaviyo_blocks_not_in_redo` says "video skipped" — update it once this ships (video now → thumbnail image w/ link).

## Done

**Change** — `src/parser/blocks/klaviyo-specific.ts`, `kl-video` branch (was an unconditional skip):
- Locate the `kl-video` td (`findCls($wrapper, "kl-video")`). If it has both an `<img src>` and an `<a class="kl-img-link" href>`, route the td straight through the existing `parseImageBlock($, $videoTd, $wrapper, ctx)` — thumbnail src → `imageUrl`, video href → `clickthroughUrl`. The image parser already reads `kl-img-link` into `clickthroughUrl` and runs it through `classifyKlaviyoUrl`; an external youtu.be URL passes through as a normal web-page link (not mangled).
- Records a `degraded-mapping` warning ("static thumbnail Image … no play affordance … merchant may want to review"). No longer pushed to `skippedBlocks`.
- Conservative fallback: a `kl-video` with no thumbnail img OR no link keeps the old skip behavior (now reasoned "no thumbnail image to convert"). The preview-quote / html / drop-shadow branches are untouched.

**Verify (real Tiny Boat template `R3rU5j-autoboat-template.html`, via `parseKlaviyoHtml`):**
- Emits an Image block: `imageUrl = https://d3k81ch9hvuctc.cloudfront.net/company/X5pGs7/images/2f50fee9-08c5-4cab-8813-1d0ca97920d9.png`, `clickthroughUrl = https://youtu.be/dpJBQQ9fIi0?si=rhb8x2-p7RT9Sm6Y`, `altText = "AutoBoat In Action"`.
- `skippedBlocks` no longer lists the video (0 video entries); degraded-mapping warning present.
- Smoke test `src/parser/blocks/video-block.smoke.ts` (happy path + both no-thumbnail / no-link fallbacks) — all assertions pass.
- Regression: `npx tsx src/parser/batch-test.ts` → `Total: 416  Clean: 70  Warned: 346  Failed: 0`.
- `npx tsc --noEmit -p .` → 36 errors, unchanged from baseline (zero new; the one diff is the pre-existing `"html"`-blockType error shifting line number 59 → 82 as lines were added above it).

**Memory follow-up:** this supersedes the "video dropped" half of memory `project_klaviyo_blocks_not_in_redo` — Klaviyo video now imports as a static thumbnail Image block with the video URL as clickthrough (only the preview-quote / drop-shadow cases there still describe current behavior). Memory file not edited per executor scope.

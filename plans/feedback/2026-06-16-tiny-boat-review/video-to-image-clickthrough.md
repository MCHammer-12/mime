---
status: unclaimed
branch: fix/video-to-image-clickthrough
pr: null
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
(filled by executor)

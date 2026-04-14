# Image block: session wrap-up & follow-up work

Completed: URL extraction, alt text, clickthrough URL from `kl-img-link`, inner padding from `kl-img-base-auto-width` (falls back to direct img container td), section padding from outer wrapper td, constrained-width detection (images narrower than available area get calculated horizontal padding to center them), `showCaption: false` default.

Fixes are isolated to `src/parser/blocks/image.ts` and `src/renderer/blocks/image.tsx`.

---

## PRIORITY 0: URL classification for image clickthroughs

Image `clickthroughUrl` doesn't go through `mapKlaviyoLink` or the three-state classifier (mapped / unsupported / review) that `button.ts` uses. Klaviyo variables like `{{ event.URL }}` in image anchors are extracted verbatim instead of being classified.

**Action** (same fix as `TODO-SHARED-button.md` Priority 0 cross-cutting observation):

1. Pull `classifyVariable` + `extractVariableName` out of `button.ts` into `src/parser/url-mapping.ts` (shared file — coordinate with button terminal)
2. Also hoist `UNSUPPORTED_VARIABLES` list
3. In `image.ts`, call `mapKlaviyoLink` on the extracted href
4. Emit `REVIEW:` / `UNSUPPORTED:` warnings via the same convention

See `project_image_as_button_conversion.md` memory for the related case where Klaviyo CTA images with `{{ event.URL }}` should be converted to Redo button blocks (separate AI transformation, not this TODO).

---

## PRIORITY 1: Type fields missing from ImageBlock

Prod Zod `imageSchema` requires fields not present in our local `ImageBlock` type:

| Field | Prod requirement | Our state |
|---|---|---|
| `showCaption` | required boolean | ✅ parser sets `false`, but our type marks it optional |
| `horizontalPadding` | required `Size` enum | ❌ missing |
| `verticalPadding` | required `Size` enum | ❌ missing |
| `imageSourceType` | optional `ImageType` | ❌ missing (may not matter for migrations) |

`horizontalPadding` and `verticalPadding` are Size enum (`small` / `medium` / `large` / `custom`) with numeric values derived by `getPadding()` in `email-builder.ts`. Pixel values go in `padding`, enum goes in these fields. For migrations we'll always emit `custom` with the exact pixel values in `padding`.

**Action:** when types freeze lifts, add these three fields to `ImageBlock` in `src/renderer/types.ts` and update parser to emit `horizontalPadding: Size.CUSTOM, verticalPadding: Size.CUSTOM` by default.

---

## PRIORITY 2: Aspect ratio not extracted

Prod schema accepts optional `aspectRatio: number`. Parser doesn't currently extract it. Klaviyo image HTML has `<img width="..." height="...">` attrs; could compute `width/height`. Probably not needed for migration rendering (images render at their natural aspect ratio), but if Redo's builder shows layout issues on images with explicit aspect ratios, add extraction.

---

## PRIORITY 3: Crop config unhandled

Prod schema has optional `cropConfig` (V1) and `cropConfigV2`. Klaviyo doesn't ship crop metadata in HTML — cropping in Klaviyo bakes into the source image. Decision: don't emit crop config; use the image as-is. If a template looks wrong after import because Klaviyo's visual crop differs from the source dimensions, revisit.

Note: `createTemplate` does NOT auto-convert V1→V2 (only `updateTemplate` does). If we ever start emitting crop config, emit V2 directly.

---

## PRIORITY 4: Image URLs stay on Klaviyo CDN

Parser emits image URLs as-is, pointing at `d3k81ch9hvuctc.cloudfront.net/company/<id>/images/...`. Redo will load these from Klaviyo's CDN directly at render time.

**Options:**
- **Keep as-is** (current): works, but templates break if merchant's Klaviyo account is deleted
- **Rehost to Redo CDN** during import: more robust, needs an S3 upload step in the executor

Recommendation: keep as-is for MVP. Flag if any merchant actually deletes their Klaviyo account post-migration.

---

## Cross-cutting observations

### Constrained-width detection assumes fixed email width

The constrained-width padding math uses `EMAIL_MAX_WIDTH_PX = 600` and subtracts `sectionPadding.left + sectionPadding.right`. Works for standard 600px Klaviyo emails. If a template has a non-standard width, padding will be wrong. Low priority — audit if a template surfaces with odd image positioning.

### Header logo → Image pattern

`src/parser/blocks/header.ts` now emits an `ImageBlock` for the logo (not a `HeaderBlock` — see DECISIONS.md 2026-04-14). The padding math there mirrors the constrained-width math here. Keep them consistent if either changes.

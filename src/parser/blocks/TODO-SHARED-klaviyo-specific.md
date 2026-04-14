# Klaviyo-specific blocks: follow-ups

Covers the three Klaviyo block types with no Redo equivalent (see `project_klaviyo_blocks_not_in_redo` memory). Current behavior in `klaviyo-specific.ts`:

| Klaviyo block | Detection | Output | Warning prefix |
|---|---|---|---|
| Video | `kl-video` class anywhere in wrapper | skip | `SKIPPED:` |
| Preview quote (review) | `kl-review-gutter` inside wrapper OR wrapper class matches `kl-review-*` | skip | `SKIPPED:` |
| Drop shadow | wrapper has `<img src="*bottom_shadow_*.png">` | Image block using local path OR skip | none on success; `REVIEW:` if body bg ≠ white |

## Priority 0: Hoist drop-shadow asset to CDN

`imageUrl` is set to the local path `pics/drop-shadow.png`. This will not load when the template is rendered in Redo. Before running migrations against prod templates:

1. Upload `pics/drop-shadow.png` to the same CDN/bucket Redo uses for stock imagery
2. Replace `DROP_SHADOW_LOCAL_PATH` in `klaviyo-specific.ts` with the CDN URL

## Priority 1: Warning prefix convention → structured fields

Same story as button.ts — `SKIPPED:` / `REVIEW:` strings in `warnings[]` should become fields on `ParseResult` once `src/parser/index.ts` is unfrozen:

```ts
interface SkippedBlock {
  blockType: "video" | "preview-quote" | "drop-shadow";
  reason: string;
}
```

Thread through the dispatcher and migrate both button and klaviyo-specific to the new shape at the same time.

## Priority 2: White-background detection edge cases

`isWhiteBackground` currently matches: `#fff`, `#ffffff`, `white`, `rgb(255,255,255)`, `rgba(255,255,255,1)`. Not covered:
- Alpha < 1 rgba (e.g. `rgba(255,255,255,0.95)`) — treat as non-white (conservative)
- Near-white hex like `#fefefe` — treat as non-white (conservative)
- HSL notation — currently treated as non-white

Acceptable for now; revisit if drop-shadow conversions are being rejected on templates that visually look white.

## Priority 3: Other `bottom_shadow_*` variants

Seen in templates: `bottom_shadow_222.png`, `bottom_shadow_444.png`. Current drop-shadow asset `pics/drop-shadow.png` is a single variant — if the source-to-visual match matters, we'd need multiple assets keyed on the filename suffix. Not believed to matter visually (the shadow intensity difference is subtle and most users won't care), so dropped to one asset. Revisit if a template's drop shadow looks noticeably wrong after import.

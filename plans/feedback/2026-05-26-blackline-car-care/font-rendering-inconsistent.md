---
status: blocked
branch: fix/font-rendering-inconsistent
pr: null
blocked-on: Redo editor runtime (FOUT) + a non-Google-font preflight decision
---

# Imported fonts render inconsistently in Redo editor

## Feedback (verbatim)

YvCSGH ("5 Days Until Launch  3/14"), note by Austin:

> The fonts are being weird. The font family is imported, but sometimes it is not actually showing. It will show for a split second and then it will go back to the serif fallback.
>
> With Poppins Thin, now it's not doing anything. I'm going to use the font Chirp Medium. Some portions of it are the fallback serif font, which is not the Chirp Medium, and other portions, like the As, are Arial. Just not entirely sure what's happening, but I think there might be something wrong with it.

Symptoms:
1. **Flash of styled text → revert to fallback** — font loads briefly then disappears. Classic FOUT-style timing or @font-face load failure.
2. **Poppins Thin (weight 100) doesn't render at all** — likely a missing weight in the brand-kit upload.
3. **Chirp Medium has mixed rendering** — some glyphs are serif fallback (font not loaded for those characters), others are Arial (weight or family mismatch).

## Root cause

This is **not** the same as Charlie 1 Horse's "no font family selected" issue — Blackline's fonts ARE imported. They just don't render reliably. Diagnosis area:

1. **Brand-kit font weight coverage.** Per memory `project_brand_kit_font_weight_convention`: mime creates one `CustomFontFamily` per weight ("Poppins SemiBold" etc.), skips 700/800, sets style `weight: "400"` so @font-face matches default requests. If weight **100 (Thin)** isn't being uploaded, Poppins Thin requests would fall through to default Poppins (which is weight 400) — but Austin reports Thin "not doing anything", suggesting it falls through entirely past Poppins to a system default.
2. **Chirp Medium is not a Google Font.** It's Twitter/X's proprietary font. mime fetches @font-face URLs from Google Fonts CSS2 (per `reference_brand_kit_font_upload`). Chirp will return a 404 / not-found, the brand kit ends up with a CustomFontFamily entry but no actual font file. Result: serif fallback for any character requesting it. Austin's "some As are Arial" likely indicates the @font-face is partially loading (some weight) or the editor's fallback chain hits Arial for character ranges not covered.
3. **FOUT timing.** "Shows for a split second, reverts to serif" implies CSS is applied before @font-face URL resolves, then the URL fails and the browser falls back. Could be `font-display: swap` behavior + URL 404 + missing local fallback declaration.

Relevant files (start here):
- [`src/fonts.ts`](src/fonts.ts) — main font logic (weight handling, Google Fonts CSS2 fetch)
- [`src/migrate/import-rpc.ts`](src/migrate/import-rpc.ts) — uploadFile → processFontFiles → updateBrandKit pipeline (per the reference memory)
- [`src/parser/blocks/text.ts`](src/parser/blocks/text.ts) — font-family extraction from inline styles
- [`src/parser/blocks/klaviyo-specific.ts`](src/parser/blocks/klaviyo-specific.ts) — font normalization (camelCase, family→weight split)
- `src/renderer/builder/inspectors/use-email-fonts.ts` (Redo render side; check if mime's local renderer reproduces the FOUT — if it doesn't, the bug is purely Redo's, not mime's)

## Proposed change

1. **Fetch the source HTML** for YvCSGH via Klaviyo API (key provided by Michael — don't commit it). Confirm which fonts Klaviyo specifies (inline styles → font-family value, font-weight).
2. **Check what mime's font pipeline produced** for Blackline. Inspect the brand-kit CustomFontFamily entries on the Redo team — verify:
   - Each font Klaviyo references appears as a CustomFontFamily entry (e.g. "Poppins Thin" as a distinct entry from "Poppins Regular" per the weight-per-family convention)
   - Each entry has a valid font asset URL (not a 404)
   - The `weight` style field is `"400"` so @font-face matches default browser requests
3. **Reproduce locally.** Use the local mime viewer (`src/viewer.ts` / `src/element-viewer.ts`) to render a Blackline section and check whether the inconsistent-font symptom shows up in mime's render or only in Redo's editor:
   - If it shows in mime's render → bug is in @font-face declarations (mime emits them as part of the rendered HTML)
   - If it does NOT show in mime's render → bug is in Redo's editor font loading; this becomes a redoapp issue, not mime
4. **For non-Google-Fonts fonts** (Chirp Medium, possibly Futura): mime currently has no path to upload custom font files the merchant has uploaded to Klaviyo. Either:
   - Add a fallback notice in the preflight modal when a non-Google font is detected ("This font isn't available — pick a substitute or upload manually")
   - Map known non-Google fonts to nearest Google equivalents (Chirp Medium → Inter Medium? Confirm with Michael)
   - Surface as `unsupportedFeatures` in parse-result so the operator knows pre-import

Don't ship a one-off fix for just Poppins Thin or just Chirp. The right fix addresses the missing-weight pattern OR the missing-font-file pattern generally.

## Verify

- Re-import for Blackline: brand-kit on Redo team has the expected CustomFontFamily entries with valid asset URLs
- Open the migrated email in Redo editor: fonts render consistently, no FOUT-style flash, no Arial mixing
- Smoke test: a known Google Font with multiple weights (Poppins 100/400/600) parses + uploads + renders correctly end-to-end
- Smoke test for the negative case: a known non-Google font (e.g. Chirp) produces a clear preflight signal that operator can act on

## Notes

- **May resolve part of Charlie 1 Horse Task 4** (first-text-font-styling). Charlie's missing brand-kit families (Apple Gothic, Century Gothic Charlie) are also non-Google fonts — if the executor adds non-Google handling here, that branches into Charlie's case naturally. Coordinate by reading both task files before starting.
- **Test in actual Redo editor, not just mime's local viewer.** mime can't reproduce Redo's editor font-loading runtime; the symptom Austin reports is editor-side. If you don't have access to the Redo editor running on Blackline's team, ask Michael to share access or to test the change for you.
- If diagnosis concludes this is a Redo editor bug (not mime), mark `blocked` and surface to Michael — likely needs a redoapp PR + cross-team coordination.

## Done

**BLOCKED — diagnosed 2026-06-26 (troubleshoot bundle on disk).** Two findings:

1. **The reported symptom is Redo-editor-side, not mime.** The bundled
   `template-YvCSGH` source references only **Ubuntu / Futura / Arial** — never
   the "Poppins Thin" or "Chirp Medium" Austin named (those were him
   experimenting in the Redo editor). `parse-result.json` has `warnings: []`
   with Futura the sole `available:false` font. The FOUT / flash-to-serif is
   Redo's editor font-loading runtime, which mime can't reproduce or fix.
2. **The one real mime lever is decision-gated.** A preflight notice for
   non-Google fonts (Futura here, Chirp generally) — "this font isn't on
   Google Fonts, pick a substitute or upload manually" — is the only mime-side
   change, and the task itself flags it needs Michael's call (map to a Google
   equivalent? surface-and-warn? leave as-is). Same family as the #111 font
   preflight and the Tiny Boat `font-system-not-selectable` decision.

No confident code change available without (1) Redo-editor access and (2) the
non-Google-font policy decision.

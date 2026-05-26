---
status: done
branch: fix/first-text-font-styling
pr: https://github.com/MCHammer-12/mime/pull/76
---

# First text block has wrong font-size and missing font-family

## Feedback (verbatim)

Reported on **all 6 templates**:

- RYhKut, WeieJr, VRDxJu: "first text duplicated, font size is wrong. no font family was selected"
- SxWYeY: "Wrong font size for the first text - font family not indicated"
- WgXbn6, U3cE5u: "First Text: Text font size is wrong, font family not specified"

i.e. the very first text block in each email comes out with the wrong font-size AND no font-family set.

## Root cause

**Wait until Task 1 (universal duplication) lands** — the "first text duplicated" framing strongly suggests one of two scenarios:

- **Scenario A: Task 1 fixes this entirely.** If the duplication is happening because the parser visits two structural variants of the same row (e.g. desktop + mobile MJML), the "wrong font" complaint may be the styling of the mobile-variant text block leaking through. Once de-duped, the first text picks up the correct desktop styling. Verify by re-running the parse on Charlie 1 Horse after Task 1 lands.
- **Scenario B: It's a real font issue.** The text-block parser isn't extracting the inline `style="font-family: …; font-size: …"` from Charlie's first text correctly. Could be:
  - The styling is on a parent (e.g. `<td>`) not the `<p>`/`<span>` the parser reads
  - The font-family is one of the missing brand-kit families (per `parse-result.fontPlanEntries`, Charlie uses "Apple Gothic" + "Century Gothic Charlie" which aren't available)
  - The parser is dropping font-family during normalization (per memory `project_custom_font_issue`)

Relevant files:
- [`src/parser/blocks/text.ts`](src/parser/blocks/text.ts) — text-block parser
- [`src/parser/style-utils.ts`](src/parser/style-utils.ts) — inline CSS parsing
- [`src/parser/blocks/klaviyo-specific.ts`](src/parser/blocks/klaviyo-specific.ts) — font normalization for non-default families
- [`src/parser/font-plan.ts`](src/parser/font-plan.ts) — brand-kit availability check

## Proposed change

1. **First**, wait for Task 1 to merge. Then re-run the parse on a Charlie template (VRDxJu is smallest) and check whether the font issue persists.
2. If it persists, capture the raw HTML for the first text block in one of the templates (devtools or grep the source). Identify:
   - What's the actual inline `font-size` and `font-family` value Klaviyo emits?
   - Where in the DOM ancestry is it (on the `<p>`, the `<td>`, the row wrapper)?
3. Fix the appropriate parser:
   - If font-family is "Apple Gothic" or "Century Gothic Charlie" (missing brand-kit families per font plan), the existing preflight-block should be catching this — confirm it ran and the operator was prompted.
   - If font-size is being dropped, fix the inline-style read in `text.ts`.
   - If font-family normalization is mapping it to something unexpected, fix `klaviyo-specific.ts`.

## Verify

- Re-parse a Charlie 1 Horse template: first text block has both a `font-size` and `font-family` set, matching what Klaviyo renders
- Visual viewer shows the first text at the intended size + family (or a defensible fallback per the font-plan flow)
- Other text blocks in the same template still parse correctly

## Notes

- **Strong suspicion this resolves with Task 1.** Don't sink hours into investigation if Task 1 lands and the symptom disappears.
- Charlie's missing brand-kit families: `Apple Gothic`, `Century Gothic Charlie`. If the first-text uses either, the preflight modal should have surfaced this to the operator at import time — check whether the operator declined to add them (which would explain the "no font family was selected" report).
- The "second text duplicated" reports across all 6 templates is part of Task 1, not this task.

## Done

- PR: https://github.com/MCHammer-12/mime/pull/76
- Confirmed Scenario B (real font issue, not solely a duplication artifact).
  After Task 1's fix, the first-text fontSize is still wrong on all 6
  templates. Investigated each template's HTML structure:
  - **Welcome 1/2/3** (RYhKut, WeieJr, SxWYeY): `<div font-size:14px>` wrapper
    with `<span style="font-size: 32px">` inside. Parser was reading the 14
    from the outer; the 32 is what the merchant authored.
  - **AC/Browse** (WgXbn6, U3cE5u, VRDxJu): `<div font-size:14px>` wrapper
    with `<h2>` inside but **no inline font-size on the span inside the h2**.
    No inline value to hoist — the merchant's intent is the h2 browser
    default size.
- Fix shape:
  - Added `extractDominantInlineFontSize` in
    [`src/parser/blocks/text.ts`](../../../src/parser/blocks/text.ts) that
    scans inline `font-size` declarations on `<span>` / `<p>` / `<hN>` tags.
  - Hoists the inline value **only when all inline sizes agree on one
    value** (single distinct). The unanimity guard is the safety net: a
    block mixing heading + body sizes has no single intent to promote, so
    it falls back to the outer div size — keeps body text from silently
    growing into the heading's size.
  - Mirrors the existing inline-font-FAMILY hoist at
    [text.ts:496](../../../src/parser/blocks/text.ts#L496).
- Verification:
  - Charlie RYhKut first text: `fontSize: 14 → 32` (matches merchant intent)
  - WeieJr / SxWYeY: will resolve to 32 after Task 1 (#75) lands — their
    mobile-only variants currently show up first in the section list with
    their mobile-optimized 19/20px sizes
  - batch-test on 416 templates: 0 failures, same clean/warned counts
  - Sample diffs (Quikcamo YjRTWe / X57xAh / H76ZS6): all fontSize changes
    are from a Klaviyo-reset value to a single-distinct-inline value the
    merchant authored. No body sizes grown into headings.
- **Not in scope (deferred):**
  - **`<h2>` wrapping without inline span font-size** (WgXbn6 / U3cE5u /
    VRDxJu first text). Adding heading-default fallback (h1=32, h2=24,
    h3=19) would address these but changes behavior for ~10% of the
    historical corpus (31 + 10 templates in test-account + merchant-2).
    Unclear how Redo's Quill renders `<h2>` inside a text block —
    if it honors heading tags natively, the merchant might already see
    big text and the complaint may be about font-family instead. Park
    as separate task pending confirmation of Quill's behavior.
  - **Font-family "not selected" report** — parser emits
    `fontFamily: 'Aleo SemiBold'` which matches Redo's brand-kit weight
    convention. If Charlie 1 Horse's brand kit doesn't have the SemiBold
    weight registered, that's a font-plan / import-side bug separate
    from this parser fix.

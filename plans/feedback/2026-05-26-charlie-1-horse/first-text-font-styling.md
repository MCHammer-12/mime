---
status: unclaimed
branch: fix/first-text-font-styling
pr: null
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

(filled by executor on completion)

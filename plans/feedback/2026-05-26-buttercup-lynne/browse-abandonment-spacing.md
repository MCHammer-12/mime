---
status: unclaimed
branch: fix/browse-abandonment-spacing
pr: null
---

# Browse Abandonment — "Spacy was applied" (spacing regression, unclear)

## Feedback (verbatim)

Buttercup Lynne `Browse Abandonment` (R8rs5s):

> ... Spacy was applied and the social did not get the right colors

The "Spacy was applied" phrasing is ambiguous. Most likely interpretations:

1. **Extra spacing was applied** somewhere — spacer blocks added, padding inflated, or unintended line breaks
2. **A specific spacer block was inserted incorrectly** — maybe between blocks where there shouldn't be one
3. The merchant meant a literal block called "Spacy" got applied to the email — unlikely but possible if a Klaviyo block has that name internally

The "right colors" piece is a separate issue (Task 3 — socials-wrong-colors).

## Root cause

This task is **investigation-first**. Without source HTML and the Redo render side-by-side, the symptom can't be characterized. The executor needs to:

1. Pull Buttercup's BA email source HTML (Klaviyo key Michael provided)
2. Open the migrated email in Redo's editor (or local mime viewer)
3. Compare visually — where is the unexpected spacing? Between which blocks?

Possible causes once identified:
- [`src/parser/blocks/spacer.ts`](src/parser/blocks/spacer.ts) — spacer block being emitted where Klaviyo had none
- [`src/parser/blocks/text.ts`](src/parser/blocks/text.ts) — extra `<br>` or padding (per memory recent work on double-spaced text)
- [`src/parser/index.ts`](src/parser/index.ts) — dispatcher inserting empty blocks between recognized blocks
- [`src/renderer/blocks/`](src/renderer/blocks/) — Redo render adding padding the parser didn't intend

## Proposed change

1. **Reproduce + characterize.** Document in this task file exactly what extra spacing looks like (between which blocks, how much, on which email of the BA flow).
2. **Bisect.** If the spacing is consistent (e.g. between every block), it's a Redo render or a parser-emit-spacer issue. If specific (e.g. after the text block, before the products), it's content-specific.
3. **Fix the source.** Likely a small parser tweak once characterized.
4. **Smoke test.** Synthetic BA template with the same shape → expected output (correct spacing).

## Verify

- Buttercup BA email re-parsed: spacing matches Klaviyo source
- Smoke test passes
- Regression: other merchants' BA flows + any flow type that touches the same parser path

## Notes

- **Spend < 1 hour on investigation.** If you can't characterize the issue quickly (e.g. source HTML is hard to fetch, Redo editor access is gated), mark `blocked` and ask Michael to either re-do the troubleshoot bundle including screenshots or to surface the issue manually.
- Don't conflate with Charlie 1 Horse's "padding not added to image in column" (RYhKut) — different merchant, different symptom.
- Don't conflate with Charlie 1 Horse's "no padding in second text" (SxWYeY) — different merchant. Those are Charlie Task 1 follow-ups.

## Done

(filled by executor on completion)

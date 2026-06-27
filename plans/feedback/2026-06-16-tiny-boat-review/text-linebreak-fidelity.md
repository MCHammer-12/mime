---
status: done
branch: fix/text-linebreak-fidelity
pr: 145
---

# Text block line breaks wrong both ways (drops real, invents spurious)

## Feedback (verbatim)

Tiny Boat (Big 5 - Ongoing, TzNyG5), Michael:
> after it says "👉 Check out the gear and learn more about the giveaway below:" in Klaviyo there are no enters (line breaks) but in Redo there are two. why is that?
> whereas in the second text block after "Stay sharp, / Tiny Boat Nation" there are 3 line breaks in Klaviyo but none in Redo. How come?

## Root cause (from bundle)

Klaviyo's Big 5 text uses several whitespace idioms mime's text parser handles inconsistently:
- **Spacer divs**: `<div> </div>` / `<div>&nbsp;</div>` between paragraphs (visual blank lines).
- **Trailing empty divs**: `<div><strong> </strong></div>` ×3 after "Tiny Boat Nation" (the 3 line breaks Michael means).
- **Fragment comments**: `<!--StartFragment-->` / `<!--EndFragment-->` and empty `<p>`/`<span>` wrappers.

Symptom: after "...below:" the parser emits 2 breaks where Klaviyo shows 0 (likely converting empty `<p>`/fragment wrappers into `<br><br>`), and after "Tiny Boat Nation" it drops the 3 trailing empty `<div><strong> </strong></div>` (likely filtered as "no visible content").

Files: [`src/parser/blocks/text.ts`](../../../src/parser/blocks/text.ts) — block-level whitespace/`<br>` handling, empty-node filtering. Related memory: double-spacing simulation via `<br><br>` (SESSION-LOG 2026-05-07).

## Proposed change

1. Pull TzNyG5's source + redo-output (both in the bundle) and map each Klaviyo block-break idiom → what mime emits. Build a small fixture from the two flagged spots.
2. Reconcile the model: a `<div>&nbsp;</div>` / `<div><strong> </strong></div>` spacer = one intended blank line → emit one break; an empty fragment/`<p>` wrapper with no spacer intent = no break. Don't filter trailing spacer-divs as "empty."
3. Add a text smoke fixture covering: spacer-div → 1 break, trailing spacer-divs → preserved, empty fragment wrapper → no break.

## Verify
- Big 5 re-parsed: 0 breaks after "...below:", 3 preserved after "Tiny Boat Nation".
- Regression: existing double-spacing / line-height simulation unchanged; batch-test 416/0.

## Notes
- This is whitespace **fidelity**, fiddly — keep the fix to the two confirmed idioms (spacer-div, trailing spacer-div, empty-fragment) rather than rewriting text whitespace handling wholesale.
- Routes to Content cluster (D).

## Done

**SHIPPED — PR [#145](https://github.com/MCHammer-12/mime/pull/145) (2026-06-26).**

Label correction: the flagged copy lives in **VXS62D** (Boat Giveaway), not
TzNyG5 — Michael's note was filed under the wrong template (the "labels
crossed" issue). Confirmed both spots against VXS62D's `klaviyo-source.html` +
`redo-output.json`; `redo-output.json` is mime's own `exportTemplate` output
(not a Redo re-fetch), so both were deterministic mime bugs, verifiable
hermetically with no Redo round-trip.

Two opposite causes, two surgical fixes:

- **Spurious breaks** (after "…giveaway below:") — Klaviyo wraps clipboard
  fragment markers (`<!--StartFragment-->`/`<!--EndFragment-->`, Notion
  `<!--notionvc-->`) in empty `<p>`/`<div>`s; the empty block renders as a
  blank line. New `stripFragmentNoise` in [text.ts](../../../src/parser/blocks/text.ts)
  drops marker-only wrappers + strips bare markers.
- **Dropped breaks** (after "Tiny Boat Nation") — `cleanupAfterDrops` in
  [transform.ts](../../../src/transform.ts) stripped any empty inline tag incl.
  `<strong>&nbsp;</strong>`, collapsing intentional spacers to empty `<div>`s
  that Redo drops. Now matches only `\s*`, preserving `&nbsp;` spacers.

The 2026-06-25 DEFER (regression risk, needs corpus diffing) was honored, not
ignored: rebuilt a 142-template corpus and proved **visible text byte-identical
before/after** (only invisible comments + empty structural nodes changed),
`batch-test` Failed:0, `tsc` at baseline, + a new smoke
(`src/parser/text-linebreak-fidelity.smoke.ts`, 4 checks).

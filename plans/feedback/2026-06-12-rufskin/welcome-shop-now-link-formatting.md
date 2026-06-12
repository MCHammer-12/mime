---
status: unclaimed
branch: fix/welcome-shop-now-link-formatting
pr: null
---

# Welcome Series — "SHOP NOW" text link dropped + text formatting distorted

## Feedback (verbatim)

Rufskin `Welcome Series` (H8K2Tu), reviewer:

> The "SHOP NOW" text link located directly below the logo at the top of the email was not migrated.
>
> The correct fonts were not carried over either, and the text formatting was distorted during the migration. As a result, the copy appears in a very different layout compared to the original email and needs to be manually adjusted to match the Klaviyo version.

Same flow imported with `createdTemplateCount: 1, blankTemplateCount: 0`, 0 warnings — so the email parsed, but content is wrong.

## Root cause

Three sub-issues; fonts is collapsed elsewhere. Two to investigate here:

### 1. "SHOP NOW" text link below the logo dropped
A text-based link (likely a styled `<a>` inside a text/menu block, or a small standalone link row) directly under the header logo didn't migrate. Candidates:
- It's an inline `<a>` in a text block that the parser dropped or whose anchor wasn't preserved (related to Charlie Task 3 inline-anchor handling, but here the whole link is missing, not just the URL).
- It's a one-cell menu/nav row the parser didn't recognize as a block.
- It's a button-styled-as-text that fell between button and text detection.

Pull `flow-H8K2Tu/klaviyo-flow.json` (+ the template HTML via resolver/API) and find the "SHOP NOW" element's exact markup. Determine which block type it should map to and why the parser skipped it.

### 2. Text formatting distorted / layout very different
"copy appears in a very different layout." This is vaguer — could be:
- Font fallback changing line wrapping (collapses to font work — but reviewer lists fonts separately, so this may be structural)
- Text block structure (paragraph breaks, alignment, spacing) lost during parse
- A multi-column or specifically-spaced header area flattened

Likely files:
- [`src/parser/blocks/text.ts`](../../../src/parser/blocks/text.ts) — text block extraction, inline anchors, formatting
- [`src/parser/blocks/button.ts`](../../../src/parser/blocks/button.ts) — if SHOP NOW is a button
- [`src/parser/blocks/menu.ts`](../../../src/parser/blocks/menu.ts) — if it's a nav link
- [`src/parser/index.ts`](../../../src/parser/index.ts) — dispatcher, in case the row is skipped entirely

## Proposed change

Investigation-first; this needs the real source.

1. Fetch H8K2Tu's Welcome Email source HTML (Klaviyo flow JSON is in the bundle; template HTML via `/api/debug/resolve-template` or Klaviyo API — ask Michael for the Rufskin key if needed).
2. **SHOP NOW link:** locate the element, identify why it's dropped, fix the relevant block parser to emit it (text-with-anchor, button, or menu — whichever it is). Run it through `mapKlaviyoLink` so the URL rewrites correctly.
3. **Formatting:** open the migrated email vs Klaviyo original (viewer or Redo editor). Characterize the specific distortion (alignment? spacing? wrapping? block order?). Fix the smallest thing that restores layout. If it turns out to be purely font-fallback driven, mark that part resolved-by the font work and narrow this task to the SHOP NOW link.
4. Smoke test the SHOP NOW pattern.

## Verify

- Rufskin Welcome email re-parsed: "SHOP NOW" link present below the logo, correct URL.
- Layout matches Klaviyo original (or the residual difference is purely the font, tracked separately).
- Regression: other merchants' welcome/header rows unaffected (batch-test).

## Notes

- **Fonts are collapsed** to the cross-merchant font work (Charlie Task 4 / Blackline / ad-hoc font-mapping #111). Don't re-solve fonts here. If, after fonts land, the "distorted formatting" fully resolves, this task narrows to just the SHOP NOW link.
- HseqBM (Abandoned Cart) reports the same "fonts + text formatting altered" symptom — if the formatting fix here is structural (not font), check whether it also helps HseqBM. Don't expand scope to HseqBM's email in this task, but note the overlap.
- "very different layout" can also indicate a CODE-editor template (see Castle Task 1 / the CODE-fidelity batch `plans/2026-05-26-code-fidelity.md`). Check H8K2Tu's `editor_type` first — if it's CODE, this collapses into the CODE-fidelity batch instead of being a block-parser fix. If it's block-editor (SYSTEM_DRAGGABLE etc.), proceed here.

## Done

(filled by executor on completion)

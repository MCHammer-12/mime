---
status: unclaimed
branch: fix/footer-button-spacing
pr: null
---

# Footer buttons joined together without spacing

## Feedback (verbatim)

Reported on **all 6 templates**:

> Footer buttons joined together without space.

i.e. the footer's row of action buttons (shop / about / contact / unsubscribe — whatever Charlie 1 Horse's footer pattern is) renders as a continuous block with no horizontal space between adjacent buttons.

## Root cause

Klaviyo footers often use a row of small text-link "buttons" (multi-column layout). Either:
1. **Padding/margin between footer button cells is dropped** during parse → buttons render edge-to-edge
2. **The buttons are being merged into a single block** instead of preserved as separate column items with spacing
3. **Redo's button block doesn't apply the inter-button gap** that Klaviyo's footer assumes via inter-column margins

Relevant files:
- [`src/parser/blocks/button.ts`](src/parser/blocks/button.ts) — button block parser (likely the spacing reads from inline style or surrounding `<td>` padding)
- [`src/parser/blocks/column.ts`](src/parser/blocks/column.ts) — multi-button rows often arrive as column blocks; see memory `project_column_architecture`
- [`src/renderer/blocks/`](src/renderer/blocks/) — Redo render of button + column; verify whether the rendered HTML preserves whatever margin/padding the parsed block specifies

## Proposed change

1. Pull a source HTML (VRDxJu or any). Identify Charlie's footer structure — is it:
   - **Pattern A: A column block with one button per cell** → fix should be to preserve per-cell horizontal padding
   - **Pattern B: A single button block with multiple anchors** → fix the parser to split into separate button blocks with explicit spacing, OR pass a `gap`/`spacing` field if Redo's button schema supports it
2. Trace the `padding` / `margin` Klaviyo specifies between buttons. Add it to the emitted Section's spacing field (or per-block padding) so the Redo renderer reproduces it.
3. Don't add spacing that wasn't in the original — if Klaviyo's footer is genuinely edge-to-edge in the source, the symptom is in Redo's render or in how the column-to-button mapping handles it. Investigate before patching.

Wait for **Task 1 (duplication)** to land — easier to see footer spacing when there's only one footer per email.

## Verify

- Re-parse Charlie 1 Horse template: footer-button output has a per-button padding > 0 (or equivalent column spacing)
- Visual viewer: footer buttons visibly separated, matching Klaviyo's render
- Doesn't introduce extra spacing on merchants where footers were rendering correctly — regression-check via batch-test

## Notes

- Cross-cuts with full-width-button padding issue from memory `project_fullwidth_button_padding` (Klaviyo zeroes horizontal padding on full-width buttons during MJML compile). Worth checking if footer buttons share that codepath.
- Don't change footer architecture beyond fixing the spacing — leave the footer block / column structure as-is otherwise.

## Done

(filled by executor on completion)

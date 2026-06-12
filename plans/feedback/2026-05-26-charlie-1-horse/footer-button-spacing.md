---
status: done
branch: fix/footer-button-spacing
pr: https://github.com/MCHammer-12/mime/pull/80
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

- PR: https://github.com/MCHammer-12/mime/pull/80
- Confirmed Pattern A from the planner notes — Charlie 1 Horse's footer
  buttons live in a column block (`kl-column`s with `width:33.3334%`,
  `gap:0`). The `<a>` tags have asymmetric padding (`padding:15px 0 15px
  30px` on the first, `0 0 0 0` in the middle, `0 30px 0 0` on the last)
  so each `<a>` background fills its full 33.33% column width. With every
  button using the same `#FDFDFD` background color, the rendered email
  looks like a single joined bar across the footer.
- Fix shape:
  - In [`parseColumnRow`](../../../src/parser/blocks/column.ts), detect
    rows where **every column slot in every zipper row is a Button** and
    set the emitted `ColumnBlock.gap` to `8` instead of `0`. Mixed-content
    rows (image+text product cards, etc.) still emit `gap: 0`.
- Verification:
  - Charlie WgXbn6 / U3cE5u / VRDxJu — both the 2-col STORIES/SIZE CHART
    row AND the 3-col CONTACT US / SHIPPING & RETURNS / STORE LOCATOR row
    now emit `gap: 8`.
  - Counted all-button column blocks in the historical corpus:
    **0 of 370** column blocks across `test-account` + `merchant-2` are
    all-button. The new branch never fires on the existing corpus.
  - batch-test on 416-template corpus: 0 failures, identical clean/warned
    counts (75 / 341).
- **Not in scope (deferred):**
  - The merchant's "no padding on 2nd text" complaint on SxWYeY (folded
    into Task 1's discovery in the cross-cutting notes) — verify
    separately in Redo's editor post-merge; may resolve with Task 1's
    de-dup or may need its own padding fix.

# Column block: session wrap-up & follow-up work

Completed: zipper architecture (stacked component-wrappers within a multi-column row produce multiple ColumnBlocks), bail-to-standalone when products appear in multi-col rows (products are top-level only), column width extraction, vertical alignment detection, stackOnMobile from `.colstack` class, section padding/color extraction from parent chain, kl-split parsing into 2-column layout. See `project_column_architecture` memory for full rationale.

---

## PRIORITY 3: NESTABLE_TYPES policy

Current set: `TEXT`, `IMAGE`, `BUTTON`, `DISCOUNT`. Excludes: column (no nesting of columns), products (top-level only), line, spacer, header, menu, socials, footer.

If we add new block types (e.g. Products variants, Scratch-to-reveal) to types.ts, decide per-block whether they're nestable inside a column and update NESTABLE_TYPES accordingly.

---

## PRIORITY 4: Multi-block stacks within one column

When a column contains >1 nestable block stacked vertically, the parser keeps the first and warns. Observed in templates that use cell-stack layouts for product grids.

**Action:** if merchants complain about lost content, consider emitting two parallel ColumnBlocks (the "zipper" approach already used for wrapper-stacks). Low priority — first-block-only is usually what the merchant wants.

---

## PRIORITY 4: stackOnMobile detection

Uses `.colstack` class on the row. Other Klaviyo variants exist (`.row-stack`, media-query-only stacking) that aren't detected. Defaults to `true` (stacks by default) if class missing. Revisit if a template visually doesn't stack correctly on mobile after import.

---

## Cross-cutting

### Column gap

Currently hardcoded to 0. Prod uses `COLUMN_GAP = 24` as default. Klaviyo doesn't emit explicit column gaps. For now `0` is fine — Redo renders no gap which matches Klaviyo's visual output. If Redo changes its default, audit.

### Section color extraction walks parent chain

`extractRowContext` walks up 6 levels looking for a background color. Same pattern used in `parseSplitBlock`. Extract into a shared helper if a third caller needs it.

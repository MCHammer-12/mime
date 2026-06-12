---
status: unclaimed
branch: fix/rg-customer-thank-you-content
pr: null
---

# Customer Thank You — footer, right-side logo, dynamic blocks, value-table dropped

## Feedback (verbatim)

Roden Gray `Customer Thank You` (LdGN2u), reviewer:

> • The footer was not migrated correctly.
> • The logo in the email on the right was incorrect and had to be replaced.
> • The dynamic content blocks were not migrated correctly.
> • The table containing the values in the second email was not copied over during the migration and would need to be recreated manually.

Imported clean (`createdTemplateCount: 2`, only a time-delay warning) — so the emails parsed, but four content elements are wrong.

## Root cause

Four separate content-parsing issues. Each needs the real source HTML (klaviyo-flow.json is in the bundle for structure; template HTML via `/api/debug/resolve-template` or Klaviyo API — key from Michael).

1. **Footer not migrated correctly.** Recurs across merchants (Tiny Boat Task 3, Charlie footer-button-spacing). Footer links/layout lost. Files: [`src/parser/blocks/text.ts`](../../../src/parser/blocks/text.ts) (footer text + inline anchors), footer handling. Check overlap with Charlie Task 3 (inline-anchor-url-rewrite) + memory `project_klaviyo_footer_variables`.
2. **Right-side logo incorrect.** A two-logo header (e.g. brand left + partner/Garmentory right), and the right image resolved wrong — possibly picked the wrong `<img>` src, or a column/multi-image header collapsed. Files: [`src/parser/blocks/image.ts`](../../../src/parser/blocks/image.ts), [`src/parser/blocks/column.ts`](../../../src/parser/blocks/column.ts), [`src/parser/blocks/header.ts`](../../../src/parser/blocks/header.ts).
3. **Dynamic content blocks.** Klaviyo dynamic blocks (product recs / conditional content) — collapses to [Charlie Task 2](../2026-05-26-charlie-1-horse/ac-product-block-dynamic-cart.md) for products; if it's conditional-content blocks (show/hide by profile), that's a different gap — diagnose which.
4. **Value table in email 2 not copied.** A `<table>` of values (order summary / line items / price breakdown) dropped entirely. mime likely doesn't parse arbitrary data tables into a Redo block. Determine if it's an order-summary dynamic block (maps to a Redo dynamic block) or a static HTML table (no clean Redo equivalent → may need an Image fallback or a precise "table dropped" warning). Files: [`src/parser/index.ts`](../../../src/parser/index.ts) (dispatcher — table rows), [`src/parser/blocks/`](../../../src/parser/blocks/).

## Proposed change

Investigation-first per element. Fetch LdGN2u's two emails' source HTML, then:
1. Footer: align with the footer fix from Tiny Boat Task 3 / Charlie Task 3 if those landed; don't re-solve.
2. Right logo: find why the second header image resolved wrong; fix the image/column parse for multi-image headers.
3. Dynamic blocks: classify (product vs conditional-content); route products to Charlie Task 2, file conditional-content separately if that's what it is.
4. Value table: decide order-summary-dynamic vs static-table; map or warn precisely (never silently drop).

Each is independently shippable; executor may split, updating this file.

## Verify

- LdGN2u re-parsed + viewed: footer correct, right logo correct, dynamic blocks present, email-2 value table present (or a precise warning if genuinely unsupported).
- Regression: other merchants' footers/headers unaffected (batch-test).

## Notes

- **Check `editor_type` first.** If CODE, this collapses into the CODE-fidelity batch (`plans/2026-05-26-code-fidelity.md`). Clean import suggests block-editor, but rich layout (two-logo header, value tables) is CODE-ish — confirm.
- Footer is now a cross-merchant theme (Tiny Boat 3, Charlie, here). If a general footer fix is in flight, this task's footer half folds into it.
- Value-table is a genuinely new pattern (data table → Redo block). If it can't map, the right outcome is a precise warning, consistent with the "no silent drops" theme from the condition work.

## Done

(filled by executor on completion)

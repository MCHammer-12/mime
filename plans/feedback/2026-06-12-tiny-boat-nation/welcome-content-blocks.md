---
status: partial
branch: fix/tbn-trust-bar-images
pr: 126
---

**Diagnosed + #3 fixed 2026-06-12 (key provided).** Fetched the real source
(template `Vb8bZR` = Welcome #1, via the Klaviyo API) and parsed it. The 4
reviewer issues split very differently than the planner assumed — see
**## Executor investigation**. **#3 (trust-bar images) is FIXED in this PR
(#126).** The rest are NOT a parser fix: **#1 (bg image)** needs a Redo-schema
decision; **#2 (hero buttons)** already works in current code; **#4 (footer
links)** is a source-data issue (placeholder URLs). Status stays `partial`
pending direction on #1.


# Welcome Series — background image, hero buttons, trust bar, footer links broken

## Feedback (verbatim)

Tiny Boat `BM | Welcome Series` (RpEqCA), reviewer:

> The background image was not working and had to be added manually, along with the buttons in the hero section. The trust bar containing the badges did not migrate successfully, and the footer links are not functional. The unsubscribe link is the only footer link that appears to be working correctly.

Flow imported fine (`createdTemplateCount: 2, blankTemplateCount: 0`, only a time-delay warning) — so the email parsed; specific blocks are wrong.

## Root cause

Four separate content-parsing issues in one email. Each needs the real source HTML to diagnose.

1. **Background image not working.** Klaviyo section/hero background image didn't carry. Per memory `project_klaviyo_blocks_not_in_redo`, drop-shadow → Image block (white bg only); and ancestor-walking bg detection exists (SESSION-LOG 2026-05-07). A hero background-image (vs background-color) may not be extracted, or Redo's section doesn't support bg-image so it needs to become an Image block. Files: [`src/parser/index.ts`](../../../src/parser/index.ts) (bg detection), [`src/parser/blocks/image.ts`](../../../src/parser/blocks/image.ts).
2. **Hero buttons not migrated.** Buttons in the hero (likely overlaid on the bg image) dropped. If they're overlay buttons on a background, the parser may lose them when it can't represent the bg. Files: [`src/parser/blocks/button.ts`](../../../src/parser/blocks/button.ts).
3. **Trust bar (badge row) didn't migrate.** A row of trust badges (icons: free shipping, warranty, etc.) — likely an image row or a multi-column icon+text block the parser didn't recognize. Could be the same class as Castle's socials-as-images (PR #90) or a column block. Files: [`src/parser/blocks/column.ts`](../../../src/parser/blocks/column.ts), [`src/parser/blocks/image.ts`](../../../src/parser/blocks/image.ts).
4. **Footer links not functional (only unsubscribe works).** Footer nav links (Shop/About/Contact) lost their hrefs; only `{% unsubscribe %}` resolved. Per memory `project_klaviyo_footer_variables`, footer variables resolve inline in Text block. The other footer links' `<a href>` may be getting dropped during footer text handling. Files: [`src/parser/blocks/text.ts`](../../../src/parser/blocks/text.ts) (inline anchors in footer — overlaps Charlie Task 3 inline-anchor-url-rewrite), footer handling.

## Proposed change

Investigation-first — fetch RpEqCA's Welcome email source HTML (klaviyo-flow.json in bundle gives structure; template HTML via `/api/debug/resolve-template` or Klaviyo API, key from Michael).

Then per issue:
1. **Bg image:** determine if Redo section supports a bg image; if not, emit the hero as an Image block (with the buttons composited or placed after). Confirm Redo's section schema.
2. **Hero buttons:** ensure buttons are emitted even when the surrounding bg can't be represented — don't let bg failure swallow child buttons.
3. **Trust bar:** identify the badge-row markup; map to the right block (image row / column). Likely reuses the socials-as-images heuristic from PR #90 or column handling.
4. **Footer links:** run footer `<a href>` values through the same anchor-preservation path Charlie Task 3 establishes for inline anchors; ensure non-unsubscribe footer links keep their hrefs.

Each is independently shippable — the executor may split into sub-PRs if they diverge, updating this file.

## Verify

- RpEqCA re-parsed + viewed (viewer or Redo editor): hero shows bg image + working buttons; trust-bar badges present; footer links (not just unsubscribe) functional.
- Regression: other merchants' heroes/footers/badge rows unaffected (batch-test).

## Notes

- **Check `editor_type` first.** If RpEqCA's template is CODE, this collapses into the CODE-fidelity batch (`plans/2026-05-26-code-fidelity.md`) rather than block-parser fixes. The clean import (no blank) suggests block-editor, but confirm — "background image + overlay buttons + trust bar" is exactly the kind of rich layout CODE templates use.
- Footer-links issue overlaps Charlie Task 3 (inline-anchor-url-rewrite) — if that's merged, check whether it already fixes the footer links before doing more.
- Trust-bar overlaps Castle socials-from-icon-src (PR #90) pattern (row of branded icons). Reuse, don't reinvent.
- Fonts are NOT mentioned for this flow — unlike Rufskin/others, RpEqCA's complaint is purely structural. Keep it scoped to the 4 block issues.

## Executor investigation 2026-06-12 (key provided, parsed Vb8bZR)

Fetched template `Vb8bZR` (Welcome #1) via the Klaviyo API and ran it through
`parseKlaviyoHtml`. `editor_type` is block-editor (13 kl-row sections parsed
cleanly; not CODE). Findings per issue:

**#3 Trust-bar badges — FIXED (PR #126).** Root cause: the badges live in a
Klaviyo "Table" block (`kl-table` → `kl-table-subblock` cells, each a small
`kl-img`). `parseColumnContent` had no general `kl-table` handler (only
product-card kl-tables are caught, earlier), so the table fell through to the
"Unknown block" fallback and all 3 badges were dropped (image blocks: only 2 of
5 content imgs emitted). Fix: new `parseTableImageRow` (column.ts) emits the
image cells as a ColumnBlock (one badge per column), reusing `parseSplitSubblock`
per cell. Vb8bZR now emits 5 image blocks (3 badges recovered as a 3-col row),
0 Unknown-block warnings. Locked by `trust-bar.smoke.ts`; batch 416/0-failed
(Clean 69→70). Strictly additive — only affects previously-dropped kl-tables.

**#1 Background image — real limitation, needs a Redo-schema decision (NOT
fixed here).** The hero bg is the CSS `background:url(...)` **shorthand** (not
`background-image:`). `findAncestorBackgroundColor`
([`style-utils.ts:155`](../../../src/parser/style-utils.ts)) deliberately runs
the shorthand through `extractCssColor` and **keeps only the color token,
discarding the `url(...)`** — Redo's `sectionColor` is a plain color String
(passing the full shorthand 500'd `createSavedEmailTemplate`, SHOC 2026-06-08).
Section background *images* are therefore universally dropped. Needs: (a) confirm
Redo's section schema has a background-image field and populate it, or (b) emit
the hero as an Image block with text/buttons after. **Decision needed before
coding.**

**#2 Hero buttons — already works (NOT a bug).** Current parser emits all 3 hero
buttons. The troubleshoot predates the fix. (If they "feel" missing it's because
they sit below the dropped bg-image hero rather than overlaid — a consequence of
#1.) Verify on re-import.

**#4 Footer links — source-data, NOT a mime bug.** The footer text block
preserves its `<a href>` anchors, but the source hrefs are literally
`http://www.klaviyo.com` — Klaviyo's default placeholders the merchant never
updated. mime migrated them faithfully; it can't invent the real FAQ/contact
URLs. Only `{% unsubscribe %}` resolves (Klaviyo fills it server-side). Optional
marginal follow-up: warn when a footer anchor points at `klaviyo.com`.

Source HTML cached at `migrations/tiny-boat/templates/` (gitignored) +
`/tmp/tbn-Vb8bZR.html` for re-runs.

## Done

**#3 trust-bar shipped — PR #126 (2026-06-12).** See investigation above. #1
awaits a Redo-schema decision; #2 already works; #4 is source-data. Task stays
`partial` until #1 is decided.

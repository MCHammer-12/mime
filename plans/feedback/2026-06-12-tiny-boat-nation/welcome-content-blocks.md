---
status: blocked
branch: fix/welcome-content-blocks
pr: null
---

**Diagnosed 2026-06-12 (key provided).** Fetched the real source (template
`Vb8bZR` = Welcome #1, via the Klaviyo API) and parsed it through
`parseKlaviyoHtml`. The 4 issues split very differently than the planner
assumed — see **## Executor investigation** below. Net: only **#3 (trust-bar
images)** is a clean mime bug; **#1 (bg image)** needs a Redo-schema decision;
**#2 (hero buttons)** already works in current code; **#4 (footer links)** is
a source-data issue (placeholder URLs), not a mime bug. Not a single-PR
"investigate-each-block" task — kept blocked pending direction on #1 + #3.


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

**#1 Background image — real mime limitation, needs a Redo-schema decision.**
The hero bg is set with the CSS `background:url(...)` **shorthand** (not
`background-image:`). `findAncestorBackgroundColor`
([`style-utils.ts:155`](../../../src/parser/style-utils.ts)) deliberately runs
the shorthand through `extractCssColor` and **keeps only the color token,
discarding the `url(...)`** — because Redo's `sectionColor` is a plain color
String (passing the full shorthand 500'd `createSavedEmailTemplate`, SHOC
2026-06-08). So section background *images* are universally dropped. Fix needs
one of: (a) confirm Redo's email-template section schema has a background-image
field and populate it, or (b) emit the hero as an Image block with the text +
buttons placed after. **(a)/(b) is a Redo-schema + layout decision — not a
unilateral parser tweak.**

**#2 Hero buttons — already works.** Current parser emits all 3 hero buttons
(`button, button, button` after the "WELCOME ABOARD!" text). The troubleshoot
predates whatever fixed this. No code change; verify on re-import. (If they
"feel" missing it's because they sit below the dropped bg-image hero rather
than overlaid on it — that's a consequence of #1, not a button bug.)

**#3 Trust-bar badges — the one real, fixable mime bug.** The source has 5
non-social content `<img>`s; the parser emits only **2** image blocks (logo +
one content image), so ~3 badge images are dropped. They sit in a nested
`<table><tr>…<a><img></a></table>` badge row that the kl-row/column walker
isn't turning into image blocks. **Fixable in the parser**, but needs care in
[`column.ts`](../../../src/parser/blocks/column.ts) /
[`image.ts`](../../../src/parser/blocks/image.ts) row handling + a batch-test
regression pass (the walker is shared). This is the concrete win if pursued.

**#4 Footer links — source-data, NOT a mime bug.** The footer text block *does*
preserve its `<a href>` anchors (3 of them survive). But the source hrefs are
literally `http://www.klaviyo.com` — Klaviyo's default placeholder links the
merchant never updated. mime migrated them faithfully; it cannot invent the
real FAQ/contact URLs. Only `{% unsubscribe %}` resolves to a real link because
Klaviyo fills it server-side. **Optional marginal improvement:** emit a
review-warning when a footer anchor points at `klaviyo.com` so the operator
knows to fix it. No faithful auto-fix exists.

**Recommendation:** pursue **#3** as a focused parser PR (with regression
guard); get a decision on **#1** (Redo section bg-image support vs
hero-as-Image-block) before coding; close **#2** as already-working on
re-import; treat **#4** as source-data (optionally add the klaviyo.com-href
warning). Source HTML cached at `migrations/tiny-boat/templates/` (gitignored)
+ `/tmp/tbn-Vb8bZR.html` for re-runs.

## Done

(filled by executor on completion)

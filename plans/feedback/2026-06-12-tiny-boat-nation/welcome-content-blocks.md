---
status: blocked
branch: fix/welcome-content-blocks
pr: null
---

**Blocked 2026-06-12 — needs the Tiny Boat Klaviyo key.** All 4 issues
(background image, hero buttons, trust bar, footer links) are content-
parsing bugs that require the real `RpEqCA` Welcome-email source HTML to
diagnose and fix. The troubleshoot bundle only contains `klaviyo-flow.json`
+ `parse-result.json` + `notes.md` — **no template HTML** (parse-result has
placeholders only). Can't reproduce or fix without fetching the template
from Klaviyo (`/api/debug/resolve-template` or the Klaviyo API), which
needs Tiny Boat's private key. Unblock: provide the key, then this becomes
a straightforward investigate-each-block task.


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

## Done

(filled by executor on completion)

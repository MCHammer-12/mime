---
status: unclaimed
branch: fix/universal-block-duplication
pr: null
---

# Universal block duplication across all 6 Charlie 1 Horse templates

## Feedback (verbatim)

Pulled from `notes.md` across all 6 templates — the consistent thread is "everything duplicated":

- RYhKut: "Header duplicated. Images duplicated. first text duplicated. second text duplicated. Footer duplicated. Socials duplicated twice. Footer buttons joined together without space."
- WeieJr: "Header duplicated. first text duplicated. second text duplicated. Footer and socials duplicated."
- SxWYeY: "Header duplicate. Menu duplicate. First text, second text and 'Now Let's Shop' button duplicated. straw hats and felt hats buttons duplicated. Footer and socials duplicated."
- WgXbn6: "Header and header-menu copied twice. Second text duplicated. Return to cart button duplicate found. Footer and socials duplicated."
- U3cE5u: (same as WgXbn6)
- VRDxJu: "Header duplicated. first text duplicated. second text duplicated. shop now button duplicated. Footer and socials duplicated."

## Root cause

Duplication is in **mime's parse output**, not Redo's render. Evidence from `parse-result.json`:

- RYhKut (Welcome 3): `sectionCount: 35` — way too many for a welcome email; warnings contains `"Dynamic product block → Best Sellers filter (3 products × 3 cols)"` **twice**, confirming the dynamic product block is parsed 2x
- VRDxJu (Browse Abandonment): `sectionCount: 24` — same issue; `substitutions` array has `"{{ first_name }} → {{ customer_first_name }}"` **twice** and `"button link: {{ organization.url }}" → "http://www.charlie1horsehats.com"` **twice**
- RYhKut: `reviewItems` has 2 entries for `organization.url` (button block)

So the parser is visiting and emitting each row/block twice. The dispatcher is in [`src/parser/index.ts`](src/parser/index.ts) (kl-* class walker). Most likely cause: the Klaviyo HTML has a structural wrapper Charlie 1 Horse uses that mime visits both sides of (mobile + desktop variants, MJML hide-on-* tables, or doubled section wrappers). This pattern hasn't shown up in any previous merchant — RodenGray, Goumikids, Defiance, Fairechild parse fine — so it's likely something specific to either:
1. A newer Klaviyo template export format that adds a duplicate desktop/mobile shell
2. A specific Klaviyo template Charlie 1 Horse cloned and modified
3. A class-name pattern the dispatcher walks recursively without de-duping

## Proposed change

This needs investigation, not a pre-written fix. Steps:

1. **Get one source HTML.** Easiest: VRDxJu (smallest, only 24 sections). Either via `/api/debug/resolve-template` on the Replit deploy, or by pulling directly from Charlie 1 Horse's Klaviyo via the key in DB (`SELECT klaviyo_key FROM stores WHERE name = 'Charlie 1 Horse'`).
2. **Run [`src/parser/smoke-test.ts`](src/parser/smoke-test.ts) locally** on the saved HTML. Confirm the emitted `Section[]` literally contains each block twice.
3. **Compare HTML structure** vs. a known-good merchant (e.g. one of the working Otishi/Roden Gray templates in `migrations/`). Diff the row-shell structure looking for what's extra in Charlie's templates.
4. **Patch the dispatcher.** Likely candidates:
   - [`src/parser/index.ts`](src/parser/index.ts) — `walkRows` / row-iteration logic; de-dupe by a stable key (block id or DOM position)
   - [`src/parser/helpers.ts`](src/parser/helpers.ts) — `sel` / `findCls` if they're traversing both halves of a hide-on-desktop/hide-on-mobile pair
5. **Regression-check.** Run [`src/parser/batch-test.ts`](src/parser/batch-test.ts) across `migrations/test-account/` and `migrations/merchant-2/` to make sure the fix doesn't break the 416-template corpus that currently parses cleanly.

The first-text font-size + missing font-family complaint (Task 4) is suspicious — it's reported on every template. Possible it's actually the same duplication picking up two text blocks where the second has the wrong inline style. Worth checking once duplication is fixed whether Task 4 also resolves.

## Verify

- VRDxJu's `sectionCount` drops to whatever the email actually has (probably ~10-12)
- Warnings + substitutions in `parse-result.json` no longer duplicate
- Visual viewer ([`src/viewer.ts`](src/viewer.ts)) shows one of each block, not two
- `npm run -s` equivalent of `tsx src/parser/batch-test.ts` (or the script's existing entry) passes on the historical corpus

## Notes

- **Get fresh bundle for verify step.** After the fix lands and Charlie 1 Horse re-runs the import, capture a new troubleshoot bundle and confirm `sectionCount` is sane and the assistant doesn't report duplication again.
- **Don't fix font/padding issues in this PR.** Even if you discover the root cause touches those, keep this PR scoped to the de-dup. Tasks 4 + image-column-padding stay separate so each can be reviewed independently.
- **If discovery reveals the duplication is Klaviyo-template-specific** (not a parser bug) — e.g. Charlie's templates were imported from another tool and have actual duplicate sections in source HTML — update this task file with that finding and mark `blocked` for Michael's call on whether to detect+collapse in the parser or punt to the merchant.

## Done

(filled by executor on completion)

---
status: unclaimed
branch: fix/socials-wrong-colors
pr: null
---

# Browse Abandonment — socials block has wrong colors

## Feedback (verbatim)

Buttercup Lynne `Browse Abandonment` (R8rs5s):

> ... the social did not get the right colors

i.e. the migrated socials block (Facebook/Instagram/etc. icons) renders in the wrong colors compared to Klaviyo's original. Could be wrong icon style (color vs monochrome), wrong tint, wrong background.

## Root cause

Klaviyo's socials block supports several visual modes:
- **Color icons** — full-color brand logos
- **Black-and-white / monochrome** — single tint, often customizable
- **Custom-colored** — merchant picks a color

mime's socials parser ([`src/parser/blocks/socials.ts`](src/parser/blocks/socials.ts)) extracts the icon variant + tint from Klaviyo's source. Bug surface:
1. Tint / style attribute on the socials block not being read
2. Style attribute read but normalized incorrectly (e.g. hex → named color mismatch)
3. Redo's socials block doesn't expose the same tint options, so it defaults

Relevant files:
- [`src/parser/blocks/socials.ts`](src/parser/blocks/socials.ts) — socials parser
- [`src/renderer/blocks/socials.tsx`](src/renderer/blocks/socials.tsx) — Redo socials render (per grep earlier in session this file exists)
- [`src/renderer/utils/social-links-utils.ts`](src/renderer/utils/social-links-utils.ts) — also touches socials

## Proposed change

1. **Pull Buttercup's BA email source HTML** (Klaviyo key Michael provided).
2. **Capture the socials block markup.** Note the icon URLs, the inline style on the surrounding `<td>` / `<table>`, any `kl-socials-*` classes.
3. **Compare with mime's parsed output.** Find the field that should carry the tint/style but doesn't.
4. **Patch [`src/parser/blocks/socials.ts`](src/parser/blocks/socials.ts).** Add the tint / style extraction. Map Klaviyo's variants to Redo's socials block fields (whatever those are — check the renderer for available options).
5. **If Redo's schema doesn't support the merchant's tint**: emit a `templateWarning` listing what was lost. Don't silently force a default.

## Verify

- Buttercup BA email re-parsed: socials block has the right colors (matching Klaviyo)
- Smoke test extends `src/parser/blocks/` tests with the new tint case
- Regression: socials on Charlie 1 Horse, Castle Sports, other merchants — should not regress

## Notes

- Coordinate with Charlie Task 1 (universal duplication, already merged) — Charlie's complaint about "socials duplicated twice" is now resolved per git log. This task is about color, separate from duplication.
- Coordinate with Castle Task 4 (Funnest PE Games — socials dropped). That task is about socials missing entirely (parser doesn't recognize the block); this is about color (parser recognizes but extracts wrong style). They likely share a file but are independent fixes.

## Done

(filled by executor on completion)

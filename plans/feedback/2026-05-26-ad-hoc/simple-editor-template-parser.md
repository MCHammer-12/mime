---
status: done
branch: fix/simple-editor-template-parser
pr: 141
priority: high — silent blank emails (Jack Henry, 2 of 8)
---

# Klaviyo `editor_type: SIMPLE` templates parse to 0 sections (silent blank)

## Origin
Split from [`flow-email-templateid-orphaned.md`](flow-email-templateid-orphaned.md)
(Jack Henry deep-dive, 2026-06-25). Of Jack Henry's 8 abandoned-cart emails,
2 are `editor_type: SIMPLE` (ids `R2rkiC`, `Tmf26k`, ~2.8KB each). They are
plain `<div>/<span>` HTML — e.g. "Hi {{ first_name }}, Noticed you left a few
things behind…" — with **zero `kl-*` block classes**.

## Root cause
mime's block parser keys entirely on `kl-*` classes
(`src/parser/blocks/*`, `src/parser/index.ts`). A SIMPLE template has none, so
it yields **0 sections** → mime treats it as empty → blank email in Redo. No
warning today; the merchant just sees no content. Sibling to the CODE gap
(`src/parser/code-template.ts`), which got its own non-class parser path.

## Klaviyo editor types (for the router)
- `SYSTEM_DRAGGABLE` — block editor, has `kl-*` classes → current parser. ✓
- `CODE` — hand-coded HTML → `code-template.ts` path (gated). ✓
- `SIMPLE` — plain text/HTML, no `kl-*` classes → **NO path. This task.**
- `KLAVIYO` / `HTML` — filtered out upstream (`migrate.ts:97`, `server.ts:247`).

## Proposed change
1. **Detect SIMPLE** at parse entry: if `editor_type === "SIMPLE"` OR the HTML
   has zero `kl-*` classes (heuristic mirrors the CODE fallback in
   [export-template.ts:67-70](../../../src/export-template.ts)), route to a new
   minimal parser instead of the kl-class parser.
2. **Minimal SIMPLE parser**: walk the body, emit Text blocks from the
   paragraph/heading/span structure (reuse `text.ts` inline-style handling),
   Image blocks from `<img>`, Button blocks from anchor-styled CTAs. Preserve
   Klaviyo merge tags (`{{ first_name }}` etc.) verbatim — they map to Redo
   variables downstream. Keep it conservative: a faithful Text+Image render
   beats 0 sections.
3. **Never silently blank**: if the SIMPLE parser still yields 0 sections, emit
   a warning naming the template + editor_type (ties into the
   "surface resolve-failure reason" item in the orphaned-templateid task).

## Verify
- Jack Henry `R2rkiC` + `Tmf26k`: parse to ≥1 Text section with the greeting
  copy + merge tags intact; no longer blank on import.
- `batch-test` Failed: 0 (SIMPLE templates currently in the corpus, if any,
  stop counting as empty).
- New smoke: a minimal `editor_type: SIMPLE` fixture → Text block(s) emitted;
  a no-`kl-class` SIMPLE → routed to the new path, not the kl parser.
- Regression: SYSTEM_DRAGGABLE + CODE templates unchanged (router only diverts
  SIMPLE / zero-kl-class).

## Notes
- Re-import alone does NOT fix these — they need this parser path. (The 6
  SYSTEM_DRAGGABLE siblings may be fixed by re-import if their blank was deploy-
  timing; that's the other task.)
- Scope to a Text+Image+Button render for MVP; richer SIMPLE layouts (tables,
  multi-column) can degrade-warn rather than block.

## Done

**SHIPPED — PR [#141](https://github.com/MCHammer-12/mime/pull/141) (2026-06-25).**
Turned out to be a one-line routing fix, not a new parser: the existing CODE
parser (`code-template.ts`) already handles class-less HTML. The router in
[export-template.ts](../../../src/export-template.ts) now sends
`editor_type === "SIMPLE"` (and any zero-`kl-class` HTML) to the CODE path:
```ts
const hasKlClasses = /class="[^"]*(?:kl-|gxp-kl-)/.test(html);
const useCodeParser = meta.editorType === "CODE" || meta.editorType === "SIMPLE" || !hasKlClasses;
```
Plus a 0-section warning naming the editor_type + which parser ran (pairs with
#140). Verified on Jack Henry `R2rkiC` + `Tmf26k`: each now exports 1 Text
section with the greeting + merge tags intact, no longer blank. Smoke:
`src/parser/simple-editor-routing.smoke.ts` (3/3).

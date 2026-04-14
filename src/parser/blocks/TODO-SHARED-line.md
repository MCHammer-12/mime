# Line block: session wrap-up & follow-up work

Completed: border color + width extraction from `border-top` CSS, section padding from outer wrapper td, section color, inner padding from the parent td wrapping the `<p>` divider.

The parser currently returns a `ParsedLineBlock` type (extends `LineBlock` with `thickness: number` and `innerPadding: Padding` extras). These extras are renderer-only — they'll be stripped when the block round-trips through Redo's API (Zod strict validation drops unknown keys).

---

## PRIORITY 0: Type additions — thickness + innerPadding

Prod `lineSchema` does NOT have `thickness` or `innerPadding` fields. Ours does. Two paths:

**Option A — keep as renderer-only extras (current):**
Our renderer uses them for pixel-perfect rendering during preview. When the block is imported to Redo via `EmailTemplateRepo.createTemplate`, Zod will strip them. The imported template will render Redo's default thickness (1px?) and use `padding` instead of `innerPadding`. Acceptable if visual fidelity matters only during migration, not post-import.

**Option B — round-trip by stuffing into existing fields:**
Redo's `LineBlock` has `padding` (top/right/bottom/left pixels). Klaviyo's line `innerPadding` could be encoded into `padding` directly — we're already storing `padding: {top:0, right:0, bottom:0, left:0}` as a placeholder. Change parser to emit `padding: innerPadding`, drop the `innerPadding` extra. `thickness` has no target field in Redo's schema; it will be lost.

**Recommendation:** Option B. Lose thickness (per `project_line_schema_gap` memory decision — Redo uses default 1px line), preserve innerPadding via the existing `padding` field. Drop `ParsedLineBlock` type.

---

## PRIORITY 1: horizontalPadding / verticalPadding Size enum

Same as Image block. Prod `lineSchema` has required `horizontalPadding: Size` and `verticalPadding: Size` fields. Our local type omits both. When types freeze lifts, add them with `Size.CUSTOM` default (actual pixel values in `padding`).

---

## PRIORITY 2: Line style detection (dashed/dotted/solid)

`parseBorderTop` parses `solid|dashed|dotted` from the CSS but currently only returns width + color. Redo's `LineBlock` has no `lineStyle` field — only solid is supported. If a Klaviyo template uses a dashed line, we silently render it as solid.

**Action:** per `project_line_schema_gap` memory, this is accepted loss. Revisit only if rasterization-fallback approach becomes needed.

---

## Cross-cutting

### `parsePadding` shorthand override bug

`parsePadding` in `src/parser/style-utils.ts` returns early on shorthand `padding`, ignoring individual `padding-*` overrides. `text.ts` worked around this with a local `parsePaddingWithOverrides`. Line uses the shared `parsePadding` for both `sectionPadding` and `innerPadding` — if Klaviyo starts emitting mixed shorthand + specifics on line wrappers, we'll hit the same bug. Fix upstream in `style-utils.ts` per `TODO-SHARED-text.md` PRIORITY 3.

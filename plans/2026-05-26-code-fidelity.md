# Plan: CODE-template parser fidelity

**Status:** P0a + P0c shipped ([#112](https://github.com/MCHammer-12/mime/pull/112) 2026-06-09); P0b deferred; P1/P2/P3 open
**Created:** 2026-05-26

**Execution note (2026-06-09):** P0a was scoped more conservatively than
drafted. The plan suggested globally preferring the Zaymo root-container,
but a corpus scan found **118 of 368** Otishi CODE templates carry
`root-container` — preferring it everywhere would shift their parse output.
Instead table detection stays first (untouched), and root-container /
inline-`width:600px` are added only as fallbacks for the **96** templates
that currently deep-walk (the plan's "16" estimate was low). Result: Castle
RYCBtZ 33→16, and **0 section-count changes across all 368 Otishi
templates** (verified per-template), warnings 141→119. P0b turned out moot
for Castle (P0a scopes past the body-level preheader) so it was deferred
rather than adding `isVisualSkip` heuristics that risk false-positives on
the corpus.
**Trigger:** Castle Sports' `[EG]` abandonment flows (3 of 6 affected). Per [Castle Task 1](feedback/2026-05-26-castle-sports/eg-templates-blank-emails.md), Michael picked "fix CODE parser fidelity first, then ungate" — but actual current state is that the parser is already wired up via [src/export-template.ts:69-71](src/export-template.ts).

## Context

**Built 2026-04-20** ([src/parser/code-template.ts](src/parser/code-template.ts)). Two container modes: 600px-wide `<table>` and 600px-wide `<div>` fallback. 368 of Otishi's 464 templates parse with 0 failures, but a one-template push-through to the Redo builder showed visual fidelity issues. Memory tagged three gaps (image widths, per-span text, column gap). Castle Sports made CODE a production blocker.

### Castle ground-truth (template `RYCBtZ`)

Fetched `RYCBtZ` ("2024-08-14 14:32 Zaymo MC abcart_email1", 453KB) via Klaviyo API and parsed it. Findings replace the original guesswork in this plan:

**Result:** parser produces 33 sections with valid content (9 text, 18 image, 4 button, 2 column). It is **NOT** blank. The merchant's "no images" complaint is shorthand for "this is unusable" — confirmed by inspecting output, the real problems are:

1. **Each section is emitted TWICE.** Body contains two parallel copies of the email content — child `[10]` `<div style="display:table; width:100%">` and child `[18]` `<div id="bodyTable" class="root-container">`. Both are valid Zaymo-rendered email bodies. `findContainer` fails (see #2) so deep-walker visits both → 33 sections instead of ~16.
2. **`findContainer` misses 600px markers** the template actually uses. All 35 `width="600"` matches use inline `style="width:600px"` (not `max-width:600px`); all 19 `max-width:600` occurrences are inside `<style>` blocks (CSS classes), not inline attributes. Current detection only checks `max-width:600` inline or `width="600"` attribute on `<table>` — but the markup combinations don't both line up.
3. **Preheader Liquid blob leaks as visible text** (section [0]: `{% if 'placeholder' in unsubscribe_link or person.KlaviyoID|sha_256|phone2numeri...`). Klaviyo wraps preheaders in a bare `<p>` directly under `<body>` followed by hidden `<div style="display:none">` copies — current `isVisualSkip` catches the hidden div but emits the visible `<p>`.
4. **All 18 images render at 600px** — none of Castle's images have a width attribute or style. `aspectRatio` is `undefined` (no width+height) and `sectionPadding` is `{0,0,0,0}` everywhere. Without width info we can't pad-to-fit; need to fall back to height-driven sizing or accept full-width with a `reviewItem` warning.
5. **Klaviyo variable in button link not substituted.** Section [5]: `buttonLink="{{ event.extra.checkout_url}}"`. The block-editor parser handles this via `classifyKlaviyoUrl` ([url-mapping.ts](src/parser/url-mapping.ts)) — rewrites to `<storeUrl>/cart`. CODE parser's `buildButtonFromTable` calls `$a.attr("href")` directly without classification.
6. **Social icons emitted as 4 individual IMAGE blocks** (sections [12]-[15] / [28]-[31]) instead of a SOCIALS block. Castle Task 4 (`socials-block-missing.md`) was scoped to block-editor; same root issue on CODE side.
7. **Footer text loses whitespace.** Section [16]: `"1325 South 500 East, Unit 317American Fork, UT 84003customerservice@castlesports..."` — line breaks between address rows stripped during text fragment collection.

### Schema facts (verified against current code)

- `ImageBlock` ([src/renderer/types.ts:197](src/renderer/types.ts)) — `aspectRatio?`, `padding: Padding`, `horizontalPadding: Size`. Renderer at [image.tsx:194-206](src/renderer/blocks/image.tsx) sizes `<img width=…>` as `EMAIL_MAX_WIDTH_PX - sectionPadding.left - sectionPadding.right`. **Shrinking an image means widening `sectionPadding.left/right`.** Block-editor parser already does this at [blocks/image.ts:67-74](src/parser/blocks/image.ts).
- `ColumnBlock` ([src/renderer/types.ts:376](src/renderer/types.ts)) — `gap`. Renderer at [column.tsx:93-95](src/renderer/blocks/column.tsx) inserts a gap column only when `gap > 0`. **Memory was stale — parser already emits `gap: 0` correctly.** The "border-radius: 6px 0 0 6px / 0 / 0 6px 6px 0" Klaviyo pattern for visually-joined cells isn't expressible in Redo (no per-cell `bg`/`radius`) — Redo schema gap, not parser gap.
- `TextBlock` ([src/renderer/types.ts:149](src/renderer/types.ts)) — `text: string`. Renderer at [text.tsx:194](src/renderer/blocks/text.tsx) passes through `htmlReactParser`. Per-span styles in `text` SHOULD survive. Castle text content was preserved correctly in parse output; per-span styling only matters if a real template uses it AND production Quill normalizes on load.

## Approach

Workstreams **reordered by Castle ground-truth impact** (P0 dominates).

### P0a — Container detection (BIGGEST single win)

Without this fix, every Zaymo-built template double-emits every section. Fixes #1 and #2 from the ground-truth findings together because deduplication falls out of correct container selection.

Extend `findContainer` ([code-template.ts:128-159](src/parser/code-template.ts)):
- Match `style="width:600px"` (inline, no max- prefix) in addition to `max-width:600`
- Match `<div id="bodyTable">` / `<div class="root-container">` Zaymo convention as a div-mode container
- **Prefer specific markers over generic** — if a Zaymo root-container exists, use it even if a 600px table appears earlier in the document
- Skip elements with class `kl-section-outlook` (MSO-only duplicates)
- When deep-walking falls back, restrict scope to the deepest content-bearing subtree, not entire body

**Verification:** Castle `RYCBtZ` produces ~16 sections (not 33). Otishi corpus: 368/368 still parse, fewer "could not locate 600px container" warnings (target: down from 16 to <5).

**Files:** `src/parser/code-template.ts` `findContainer()` + a small subtree-scoping helper. Estimated ~40 lines.

### P0b — Preheader / non-visual top-level child skip

Castle's `<p>` preheader directly under `<body>` (not inside the container) currently bleeds through when we deep-walk. Once P0a routes us into the `root-container` subtree this is moot for Castle — but other Klaviyo-built CODE templates put preheaders inside the container too, so still worth a defensive skip.

Extend `isVisualSkip` ([code-template.ts:834-841](src/parser/code-template.ts)) to also detect:
- `mso-hide:all` in style
- `<p>` immediately under `<body>` containing only Liquid (`^{%` or `^{{`)
- Bare `<title>`, `<meta>` inside `<body>` (malformed but seen in the wild)

**Verification:** Castle `RYCBtZ` section [0] no longer emitted. Otishi corpus: no new sections lost (the heuristic shouldn't false-positive on real content).

**Files:** `src/parser/code-template.ts` ~10 lines.

### P0c — Klaviyo variable substitution in button links

Castle's `Return to your cart` button has `buttonLink: "{{ event.extra.checkout_url}}"` — should rewrite to `<storeUrl>/cart` per the cart-deeplink pattern memory `project_redo_checkout_url_resolution`.

`buildButtonFromTable` at [code-template.ts:537](src/parser/code-template.ts) bypasses URL classification. Route through the existing `classifyKlaviyoUrl` ([url-mapping.ts](src/parser/url-mapping.ts)) — same function the block-editor button parser uses.

Requires plumbing `storeUrl` into `parseCodeTemplateHtml` — currently `ParseContext` doesn't accept it. Match the block-editor parser's signature: `parseKlaviyoHtml(html, { storeUrl })`.

**Verification:** Castle `RYCBtZ` button [5] emits `buttonLink: "https://castlesports.com/cart"` when storeUrl is supplied; falls through to raw `{{ ... }}` with a `reviewItem` warning when storeUrl is absent.

**Files:** `src/parser/code-template.ts` `parseCodeTemplateHtml` signature, `buildButtonFromTable` call into `classifyKlaviyoUrl`. `src/export-template.ts` pass `opts.account?.websiteUrl` through. ~15 lines.

### P1 — Image width preservation (when width info exists)

Original W1 from v1 of this plan. Port the proven block-editor pattern. Castle's template doesn't have width info on any image so this fix isn't visible there — BUT it's high impact for Otishi and any merchant whose templates carry width attrs.

```ts
const widthPx = parsePx(style["width"]) ?? parsePx(widthAttr ?? "");
const availableWidth = EMAIL_MAX_WIDTH_PX - sectionPadding.left - sectionPadding.right;
if (widthPx && widthPx < availableWidth) {
  const slack = availableWidth - widthPx;
  if (tdAlign === "left") {
    sectionPadding.right = slack;
  } else if (tdAlign === "right") {
    sectionPadding.left = slack;
  } else {
    const hPad = Math.floor(slack / 2);
    sectionPadding.left = hPad;
    sectionPadding.right = slack - hPad;
  }
}
```

Also: `horizontalPadding: Size.MEDIUM` → `Size.CUSTOM` so builder UI surfaces explicit padding.

**Plus**: emit a `reviewItem` when an image has no width AND no height info (Castle case) — operator should review whether each hero-sized image is actually intended at 600px.

**Verification:** Smoke test covering left/center/right + no-width cases. Otishi visual diff on a known-narrow-logo template.

**Files:** `src/parser/code-template.ts` `buildImageBlock` ~20 lines. New `src/parser/code-template-image.smoke.ts`.

### P1 — Text whitespace preservation

Castle footer collapses `"317" + <br> + "American Fork"` → `"317American Fork"`. Likely `buildTextBlockFromFragments` ([code-template.ts:425-434](src/parser/code-template.ts)) joins fragment HTML with empty string when fragments span sibling block elements. Need to preserve `<br>` / paragraph boundaries when collapsing.

**Verification:** Test case in smoke covering adjacent `<p>`, `<div>`, and `<br>` content; output's plain-text rendering preserves line structure.

**Files:** `src/parser/code-template.ts` `buildTextBlockFromFragments` ~10 lines.

### P2 — SOCIALS block detection

Castle's 4-image social row (Facebook/YouTube/Pinterest/Instagram from `assets/email/buttons/subtleinverse/...`) currently emits 4 IMAGE blocks. Pattern detection: a row of ≥3 sibling small images where each image URL matches a known platform marker (Klaviyo serves social icons from `/assets/email/buttons/`).

This is a polish issue that affects more than Castle. Worth doing but lower than P0/P1.

**Verification:** Castle `RYCBtZ` emits 1 SOCIALS block in place of sections [12]-[15] / [28]-[31].

**Files:** New helper in `src/parser/code-template.ts` detect-and-collapse pass over emitted sections. ~30 lines.

### P2 — Per-span text styling verification (W2 from v1)

Castle's parse output preserves text content correctly. Per-span styling MAY already work end-to-end. **Defer until we push a Castle template through to the Redo builder** and visually compare. If it works, close as no-op. If Quill strips on load → file Redo Asks ticket. If a specific style attribute is dropped → narrow parser fix.

**Files:** TBD pending visual reproduction.

### P3 — Column visual joining (W4 from v1, schema gap, no parser fix)

Klaviyo's "rounded pill" pattern. Emit `reviewItem` when adjacent cells have differing border-radius; park rendering fix until enough merchants flag.

## Alternatives Considered

- **Option A from Castle Task 1** (ship as-is + warning): rejected — actual output is duplicated and unreadable; warnings don't fix that.
- **Option B from Castle Task 1** (preflight warning, no parser): rejected — Castle's flows still don't work.
- **Rasterize entire CODE templates to one image:** rejected — loses editability.
- **AI rewrite CODE → block-editor shape:** rejected — non-deterministic, expensive, breaks dynamic variables.
- **Strip MSO conditionals before parse:** considered. Would clean up the source but the actual duplication root cause is two parallel content divs, not MSO. Save for later if we hit a template where MSO inner-content survives cheerio's comment handling.

## Sections (tasks)

| # | Workstream | Verification | Status |
|---|------------|-------------|--------|
| 1 | P0a — Container detection (Zaymo root-container, inline width:600) | Castle `RYCBtZ` → 16 sections (not 33); Otishi 0 section changes, warnings 141→119 | **done** ([#112](https://github.com/MCHammer-12/mime/pull/112)) |
| 2 | P0b — Preheader / non-visual top-level skip | Moot for Castle once P0a scopes into root-container (section [0] preheader already dropped). Deferred — `isVisualSkip` hardening adds regression surface across 368 templates for no Castle benefit; revisit if another template puts a preheader INSIDE the container. | deferred |
| 3 | P0c — Button link Klaviyo-variable substitution + storeUrl plumb | Castle button → `https://castlesports.com/cart`; Otishi 0 regressions | **done** ([#112](https://github.com/MCHammer-12/mime/pull/112)) |
| 4 | P1 — Image width preservation + asymmetric alignment + reviewItem on missing-width | Smoke test passes; Otishi visual diff on known-narrow-logo template | unclaimed |
| 5 | P1 — Text whitespace preservation across fragment boundaries | Footer-style address renders with line breaks | unclaimed |
| 6 | P2 — SOCIALS block detection from icon-URL pattern | Castle social row → 1 SOCIALS block | unclaimed |
| 7 | P2 — Per-span text styling visual repro on Castle template | Either close as works, or file Redo Asks, or land narrow parser fix | unclaimed |
| 8 | P3 — Asymmetric border-radius warning (no rendering change) | `reviewItem` emitted when detected | unclaimed |
| 9 | Cleanup — update memory `project_code_template_parser`, archive CONTEXT.md mention | Memory reflects new state; CONTEXT.md status line updated | unclaimed |

## Verification (cross-cutting)

- **No regression on the 368 Otishi CODE templates** — `npx tsx src/parser/code-template-smoke.ts migrations/otishi` shows 0 parse failures. Section count may change (P0a deduplicates, P0b removes preheaders, P2 collapses socials) — track the delta, justify changes.
- **Castle `RYCBtZ`** produces ~16 deduplicated sections with images at intended sizes, button link resolved, no preheader leak, footer text preserving whitespace, and 1 SOCIALS block in place of 4 image blocks.
- **Castle other flow templates** (Browse Abandonment WrazNX, No-Discount-Code R9iyHp) — fetch + parse; confirm same fixes apply.
- **Push-to-builder check** on 1 Castle template + 1 representative Otishi template via the existing import path. Visual check in the Redo builder vs Klaviyo source. Document gaps that remain.

## Open questions for Michael

1. **Execution order** — P0 trio (container + preheader + button link) gives Castle a usable import alone. Should I land them as one PR (faster, lower review surface) or three (cleaner blame, atomic rollback)? Recommend: **one PR** since they're all routing/detection on the same template family and verified together.
2. **Otishi reset cadence** — once P0 lands, the section count on Otishi may drop noticeably (deduplication). Worth a one-time check across the corpus to identify any genuine regressions (templates whose only "content" was in a chunk we now skip).
3. **W4 schema-gap workaround** — for the rounded-pill pattern, do we file a Redo Asks ticket now or wait for a merchant flag? Recommend: file the ticket once we see a Castle / Otishi template that visibly suffers from it.
4. **Ungating** — the CODE parser is currently always-on. Once P0+P1 land, do we want any opt-out path (per-merchant flag in `stores`), or is "always on" fine?

## Notes

- Memory `project_code_template_parser` is wrong about the gate ("intentionally inert") — needs updating after this lands.
- The Castle Task 1 file similarly references "removing the gate" — no gate to remove. Once P0 lands, Castle Task 1 can be marked done with no production-code wiring change.
- 1067 MSO conditionals in `RYCBtZ` are cheerio-correctly treated as comments — their inner content is NOT in the DOM. So MSO is NOT the duplication cause in this template; the two parallel content divs are. Other templates may differ — re-test if we encounter one where MSO inner content IS in the DOM.
- Test harnesses `code-template-{smoke,warnings,debug,emit}.ts` already exist and work. The plan adds a focused `code-template-image.smoke.ts` for P1.

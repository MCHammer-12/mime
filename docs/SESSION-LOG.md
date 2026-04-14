# Session Log

## 2026-04-14 — Socials block deep-dive

**Done**
- Fixed `parseSocialsBlock` across three templates (H76ZS6, KT5Xxh, Kc2UBC).
- Prod-invalid `iconColor: "original"` → now mapped to `SocialIconColor.BLACK`. Prod schema allows only black/white/gray; Klaviyo `/default/` (colorful branded) icons have no perfect match, black is closest.
- Color precedence: prefers specific `/subtle/`, `/solid/`, `/white/` match over `/default/` (→ original) when icons mix, instead of last-wins.
- Alignment now extracted from wrapper's `text-align` style (was hardcoded `CENTER`).
- iconPadding read from first icon's inline-block wrapper (was last icon, which often had empty style).
- Typed output properly with `SocialItem[]`, `SocialPlatform`, `SocialIconColor` — dropped `as any` casts.

**Files changed**
- `src/parser/blocks/socials.ts`

**Decisions**
- Michael confirmed: exact icon color match isn't required, only background/URLs/padding must be correct. Mapping `/default/` → `black` is acceptable lossy conversion.

**Next steps**
1. Similar `"original"` enum cleanup likely needed anywhere else emitting `SocialIconColor.ORIGINAL` for prod output.
2. Renderer subtracts `iconPadding` from section top/bottom — that math is vertical but `iconPadding` is a horizontal gap in Klaviyo. Works visually today but flag if padding ever looks off.

---

## 2026-04-14 — Spacer block fix (parser + renderer)

**Done**
- Fixed `parseSpacerBlock` — was returning null for Klaviyo spacers because it read height from the outer wrapper TD's padding, but Klaviyo puts height in an inner `<div style="height:Npx;line-height:Npx;">` and the bg color on the inner TD (often as `background:` shorthand, not `background-color:`).
- New parser reads the inner div height, sums outer/inner TD padding, and checks both `background` and `background-color` on inner and outer TDs.
- Fixed renderer — MjmlSection defaults to `padding: 20px 0`, so a 9px spacer was rendering as 49px. Added explicit `padding="0"` on section/column/spacer.
- Verified against Kc2UBC (h=9, #ffffff) and QPETZp (h=20, #F8F8F8). Nugivf has no spacers (correct).

**Files changed**
- `src/parser/blocks/spacer.ts`
- `src/renderer/blocks/spacer.tsx`

**Next steps**
1. Audit other renderers (text, image, button, line, etc.) — the MjmlSection default `padding: 20px 0` likely inflates those too if they don't explicitly set section padding.
2. Spacer `sectionPadding` is hardcoded to zeros; swap in `parsePadding(outerStyle)` if a template ever has horizontal padding on the wrapper.

---

## 2026-04-14 — Header block deep-dive + pivot to Image block

**Done**
- Built element-isolation viewer usage into header block workflow (`npx tsx src/element-viewer.ts header <templates>`)
- Fixed initial parser discrepancies in `src/parser/blocks/header.ts`:
  - Logo height heuristic: changed `width/4` → `width/2` (2:1 is typical for logos, not 4:1). Verified against actual image (300x150 PNG).
  - Alignment: now read from `.hlb-logo` TD's `align` attribute instead of hardcoded `CENTER`
- Discovered only 27 distinct `hlb-wrapper` structures across 353 templates using it (98% are logo-only, 6% have logo+menu, 0.6% menu-only)
- Confirmed `gxp-hlb-wrapper` variant (Grid Pixel) is 91% of templates — both prefixes handled by `hasClass()`
- **Pivoted**: header parser no longer produces `HEADER` blocks. Redo's Header component auto-pulls from brand kit (unreliable for migrations). Instead, `parseHeaderBlock` now returns an `ImageBlock` with the logo. Menu items (when present) continue to be extracted separately by `parseMenuFromHeader` → `MenuBlock`.
- Logo centering preserved via calculated inner padding: `(600 - sectionPadding - logoWidth) / 2`, so a 300px Klaviyo logo renders at ~300px in the 600px Redo email.

**Key decisions**
1. **Don't use Redo Header block for migrations** — it auto-pulls logo from brand kit which isn't guaranteed to be set. Use Image block instead for deterministic output.
2. **Logo width preservation via padding math** — ImageBlock is always full-width, so we inject horizontal inner padding to shrink the rendered image to the original Klaviyo logo width.
3. **Dispatcher unchanged** — `parseHeaderBlock` function name kept (misleading now), since `src/parser/index.ts` is a frozen shared file during parallel block work.

**Files changed**
- `src/parser/blocks/header.ts` — now produces `ImageBlock` with calculated padding to preserve logo width

**Non-hlb templates** (~35 templates, cart-discount, checkout-discount, etc.) use plain `kl-image` blocks for logos. Those go through the regular image parser. If we want those treated like headers, needs dispatcher heuristic (first image with "logo" in alt, or similar).

**Next steps**
1. Rename `parseHeaderBlock` → `parseHeaderLogoAsImage` when dispatcher freeze lifts
2. Consider deleting `src/renderer/blocks/header.tsx` — now dead code for Klaviyo migrations
3. Menu block work: address empty menu items with no href (R68eFc has one), add dispatcher heuristic for non-hlb logos

---

## 2026-04-10 to 2026-04-13 — forwarder research + deterministic parser + local viewer

**Done**
- Unblocked redoapp GitHub access (SAML SSO auth for MCHammer-12)
- Cloned redoapp/redo monorepo to ~/code/redoapp (44k files)
- Fully mapped the production email forwarder pipeline (3 stages, 2 LLM calls) → `docs/RESEARCH-forwarder.md`
- Wrote comprehensive explainer doc → `docs/EXPLAINER-pipeline.md`
- Extracted templates from a second Klaviyo account (merchant-2, 27 templates) — confirmed kl-* class pattern is universal
- Discovered 84% of templates use `gxp-kl-*` prefix (Grid Pixel template variant) — parser handles both
- **Built deterministic cheerio parser** (`src/parser/index.ts`) — zero LLM, walks Klaviyo DOM classes:
  - Handles both `kl-*` and `gxp-kl-*` class schemes
  - Extracts all 10 AI block types: header, menu, text, image, button, line, spacer, column, socials, product grids
  - Extracts fonts, colors, padding, URLs directly from inline styles
  - 415 templates tested: 374 clean (90%), 41 with warnings, 0 failures
- **Built local email renderer** (`src/renderer/`) using production Redo block components copied from redoapp:
  - Same React → MJML → HTML pipeline as production
  - Production global styles (p margin reset, quill styles, responsive breakpoints)
  - All 10 block types rendering
- **Built side-by-side comparison viewer** (`src/viewer.ts`):
  - Klaviyo original vs Redo rendered, desktop/mobile toggle, synced scrolling
  - Playwright screenshot support for automated visual comparison
- **Built EmailTemplate exporter** (`src/export-template.ts`):
  - Outputs production-shaped MongoDB document JSON with valid ObjectIds
  - Matches exact field names, enum values, and types from redo/model/src/email-template.ts
- Added second Klaviyo account extraction (merchant-2, pk_75b33...)

**Key decisions**
1. **No LLM needed for Klaviyo migration** — Klaviyo HTML has semantic classes that map directly to Redo block types. Deterministic parser is faster, cheaper, and zero-hallucination.
2. **Copy + strip production renderer** — copied real block components from redoapp with stubs for tracking/UTM/AMP deps, rather than writing approximations.
3. **Scope: Klaviyo first, arbitrary HTML later** — nail the deterministic Klaviyo migration, then separately decide whether to improve the LLM-based forwarder for arbitrary emails.

**Files created/changed**
- `src/parser/index.ts` — Klaviyo HTML → Section[] cheerio parser
- `src/parser/style-utils.ts` — inline CSS parsing utilities
- `src/parser/smoke-test.ts` — parser test + JSON export
- `src/renderer/` — full production-cloned renderer (blocks, stubs, types, utils)
- `src/viewer.ts` — comparison viewer with desktop/mobile toggle
- `src/export-template.ts` — full EmailTemplate JSON exporter
- `src/screenshot.ts`, `src/screenshot-batch.ts` — Playwright visual comparison
- `docs/RESEARCH-forwarder.md` — forwarder pipeline breakdown
- `docs/EXPLAINER-pipeline.md` — full system explainer (Temporal, MJML, block schema, pipeline walkthrough)
- `docs/CONTEXT.md` — updated with redoapp file pointers

**Next steps**
1. Show exported EmailTemplate JSON to eng team — validate structure against a real prod document
2. Hook up to Redo API to import templates directly (POST EmailTemplate)
3. Handle edge cases: discount code detection, Klaviyo template variables → Redo variables
4. Build the flow automation duplicator (the other track — Klaviyo flow topology is already extracted)
5. Polish parser: product grid title/button extraction, line divider visibility, remaining 41 warning templates

## 2026-04-08 — extractor + flow topology breakthrough

**Done**
- Scaffolded mime as a TS/Node ESM project (`src/`, `plans/`, `migrations/`)
- Built shared Klaviyo client `src/klaviyo.ts` (paginate, retry on 429, revision `2025-10-15`)
- Extractors working end-to-end against test-account (key is Quikcamo / QuikCamo, 388 templates):
  - `src/extract-templates.ts` — 388 templates (JSON + HTML)
  - `src/extract-flows.ts` — 49 flows with FULL definition (tree topology, branch conditions, trigger metrics, profile filters)
  - `src/extract-campaigns.ts` (agent-built) — 123 campaigns with inline template HTML
  - `src/extract-images.ts` (agent-built) — 168 images deduped by content hash, cross-referenced to templates
- Built `src/visualize-flow.ts` — generates Mermaid flowchart + standalone HTML viewer from a flow bundle
- Verified V1 -- Abandoned Cart flow renders as a real tree with labeled true/false edges
- Wrote plans: `plans/v1-klaviyo-to-redo.md`, `plans/parallel-build.md`

**Key technical findings**
1. **Klaviyo template drag-drop JSON is NOT exposed.** API returns flattened HTML only. Translator must parse HTML, no block-to-block shortcut.
2. **Campaign templates are hidden.** Campaign-scoped template clones don't appear in `/templates/` listing. Their HTML is only available inline in each campaign bundle.
3. **Flow topology IS exposed — but only via `2025-10-15` revision with `additional-fields[flow]=definition`.** Earlier revisions (including 2024-10-15) return null/error. Legacy v1 API gave branch conditions but no edges. The new definition field returns: triggers, profile_filter, actions array with `links.next`, branches with `links.next_if_true`/`next_if_false`, full email metadata (subject, preview, from_label, template_id).
4. `kyle@quikcamo.com` → 44-action product-aware abandoned cart with 7 branches. Branch conditions key off specific product Name matches ("2-in-1 Leafy Face Mask..." etc.).

**Project pivot mid-session**
Originally framed as "Klaviyo → Redo migrator". Re-scoped to two tracks:
- **Track 1 (current/production):** Improve Redo's existing email forwarder (HTML → Redo JSON parser) with an LLM translator. Uses Klaviyo corpus as eval set. Requires access to redoapp GitHub repo — blocked on SAML/account auth. `MCHammer-12` is not a member of redoapp; need correct work account.
- **Track 2 (future/exploratory):** React HTML drag-drop POC (a separate Claude session was working on this).

**Parallel agent runs**
- Campaigns extractor (Task A) — completed
- Image downloader (Task B) — completed
- Task C (Redo schema) and F (Redo executor login) were supposed to run in separate windows but Task C morphed into a broader architecture analysis (see `plans/parallel-build.md` notes)

**Files changed**
- Created: `src/klaviyo.ts`, `src/extract-templates.ts`, `src/extract-flows.ts`, `src/extract-campaigns.ts`, `src/extract-images.ts`, `src/visualize-flow.ts`, `tsconfig.json`, `package.json`
- Created: `plans/v1-klaviyo-to-redo.md`, `plans/parallel-build.md`
- Created: `docs/CONTEXT.md`, `docs/SESSION-LOG.md`, `docs/DECISIONS.md`, `docs/SETUP.md`

**Next steps**
1. Resolve redoapp GitHub access (wrong account) — blocking Track 1
2. Once repo access works: clone redoapp monorepo (bazel-based), grep for email forwarder code (likely under `redo/merchant/marketing/server/`), read the current parser
3. Build an eval harness: measure current forwarder accuracy on a subset of the 388 Klaviyo templates, then compare with LLM-based parser
4. Optional: chase branch edges that resolve (we have them now) into a block-plan translator for the Klaviyo corpus
5. Task G (normalizer) and Task D (translator POC) are still queued in `plans/parallel-build.md`

## 2026-04-08 — project init
- Created docs/ scaffolding (CONTEXT, SESSION-LOG, DECISIONS, SETUP)
- Purpose: automate manual Redo processes
- Next: identify first workflow to automate

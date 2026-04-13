# Session Log

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

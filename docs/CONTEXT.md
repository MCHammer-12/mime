# mime

## Description
Automation project for manual processes Michael does at Redo. Primary target: Klaviyo → Redo email migration workflow, and improving Redo's existing HTML → JSON email parser.

## Status
End-to-end import pipeline working: parse → transform → export → import to local redoapp → render in builder. Three templates imported successfully (Newsletter #8, Newsletter #4, merchant-2 + merchant-3 accounts). Packages A-D + F (parser polish) + E1 (variable substitution) + E4 (REVIEW aggregator) complete. 804 templates parse across 3 corpora with 0 failures. Import executor in redoapp (uncommitted) handles product filter creation. Next: E2 (coupon → discount objects + AI rewrite), E3 (font provisioning, partially landed), E5 (drop-shadow CDN upload).

**CODE-template parser (2026-04-20):** First-pass parser for `editor_type: CODE` templates landed at `src/parser/code-template.ts` (table-based + div-based dialects). 368/368 Otishi CODE templates parse with 0 failures. Block detection works; visual fidelity in the Redo builder is insufficient to ship (image widths, column gaps, per-span text styling). Paused until CODE migration becomes a blocker. Gated behind `editor_type: CODE` / no-kl-class heuristic — inert for existing block-editor migrations. See `project_code_template_parser` memory for state and next-step queue.

## Two tracks
- **current/** — deterministic Klaviyo HTML → Redo Section[] parser (no LLM). Uses cheerio to walk kl-*/gxp-kl-* classes. Production renderer cloned from redoapp for local verification.
- **future/** — flow automation duplicator (Klaviyo flow topology already extracted). Also: arbitrary HTML forwarder improvement (separate from Klaviyo-specific parser).

## Tech stack
- TypeScript, Node ESM, `tsx` for execution
- cheerio (HTML parsing), @faire/mjml-react + mjml (email rendering)
- React 18 (renderer block components), html-react-parser (text block rendering)
- Playwright (visual comparison screenshots)
- bson (MongoDB ObjectId generation for export)
- Mermaid for flow visualization

## Key files — parser + renderer + viewer
- `src/parser/index.ts` — **dispatcher**: walks rows, delegates to per-block parsers (block-editor path)
- `src/parser/code-template.ts` — **CODE-template parser**: inline-styled email-table HTML (paused, see status)
- `src/parser/code-template-{smoke,warnings,debug,emit}.ts` — batch harnesses for the CODE parser
- `src/parser/blocks/<type>.ts` — per-element parsers (12 files: text, image, button, header, menu, line, spacer, socials, column, discount, product, klaviyo-specific)
- `src/parser/blocks/TODO-SHARED-*.md` — follow-up notes per element
- `src/parser/helpers.ts` — dispatcher helpers (sel, hasClass, findCls, nextId)
- `src/parser/style-utils.ts` — inline CSS parsing
- `src/parser/url-mapping.ts` — Klaviyo URL classifier, mapKlaviyoLink, UNSUPPORTED_VARIABLES
- `src/parser/batch-test.ts` — regression check across all template corpora
- `src/renderer/index.tsx` — **renderer entry**: Section[] → HTML (production MJML pipeline)
- `src/renderer/blocks/*.tsx` — production block components (copied from redoapp)
- `src/renderer/types.ts` — all Redo block types, aligned with prod Zod schemas
- `src/element-viewer.ts` — per-element isolated preview (3+ blocks of one type)
- `src/viewer.ts` — full side-by-side comparison viewer (Klaviyo vs Redo)
- `src/export-template.ts` — full EmailTemplate JSON exporter (production MongoDB shape)
- `src/migrate/review-variables.ts` — interactive CLI: aggregate `reviewItems` across a migration, classify unknown Klaviyo variables as mapped / unsupported / skip. Writes `url-mappings-pending.json` for engineer to fold into `src/parser/url-mapping.ts`.
- `src/screenshot.ts` / `src/screenshot-batch.ts` — Playwright visual comparison

## Plans
- `plans/element-deep-dive.md` — per-element parallel work breakdown (complete)
- `plans/consolidated-todos.md` — 8 work packages (A–H) for post-deep-dive refactors; A+B+C+D landed

## Import path (in redoapp, not mime)
- `~/code/redoapp/redo/manage/src/import-klaviyo-templates.ts` — executor script (uncommitted)
- Uses `EmailTemplateRepo.createTemplate` per pattern in `copy-template-to-teams.ts`
- Handles `_pendingFilter` → `recommendedProductFilterId` swap via `createProductFilter`
- See memory: `reference_template_import_path`

## Key files — extractors
- `src/klaviyo.ts` — shared client (paginate, retry, revision `2025-10-15`)
- `src/extract-templates.ts` — pulls all email templates (JSON + HTML)
- `src/extract-flows.ts` — pulls flows with FULL definition (tree topology, branch conditions, metrics)
- `src/extract-campaigns.ts` — pulls campaigns with inline template HTML
- `src/extract-images.ts` — downloads and dedupes images referenced in templates
- `src/visualize-flow.ts` — renders a flow bundle as Mermaid flowchart + HTML viewer

## Docs
- `docs/RESEARCH-forwarder.md` — production forwarder pipeline breakdown
- `docs/EXPLAINER-pipeline.md` — full system explainer (Temporal, MJML, block schema, concrete walkthrough)
- `plans/parallel-build.md` — task breakdown for parallel agent work
- `plans/v1-klaviyo-to-redo.md` — architecture plan

## Redoapp references (`~/code/redoapp/redo`)
- SES entrypoint: `redo/api/server/src/lambda/ses/forwarded-emails.ts:16`
- Workflow: `redo/temporal/temporal/src/workflows/forwarded-emails/process-forwarded-email-workflow.ts`
- Activities: `redo/temporal/temporal/src/activities/forwarded-emails/process-forwarded-email-activity.ts`
- Stage-2 analyzer: `redo/server/src/marketing/create-analyzed-marketing-email-file.ts`
- Stage-3 generator: `redo/server/src/marketing/generate-email-template.ts`
- Target schema: `redo/model/src/email-template.ts` (+ `redo/model/src/email-builder.ts` for `EmailBlockType`)
- AI block schemas: `redo/marketing/common/src/ai-email-template-types.ts`

## Working data
- `migrations/test-account/` — Quikcamo's Klaviyo account (388 templates, 49 flows, 123 campaigns, 168 images)
- `migrations/merchant-2/` — second account (27 templates)

## Run
```bash
# Extract from Klaviyo
KLAVIYO_API_KEY=... MERCHANT=<name> npx tsx src/extract-templates.ts

# Parse a template
npx tsx src/parser/smoke-test.ts migrations/<account>/templates/<template>.html

# Compare side-by-side
npx tsx src/viewer.ts --compare <original.html> <output.sections.json>

# Export as full Redo EmailTemplate JSON
npx tsx src/export-template.ts <template.html> [template-api.json]

# Screenshot comparison
npx tsx src/screenshot.ts .viewer/compare.html pics/output.png
```

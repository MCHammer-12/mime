# mime

## Description
Automation project for manual processes Michael does at Redo. Primary target: Klaviyo → Redo email migration workflow, and improving Redo's existing HTML → JSON email parser.

## Status
Deterministic Klaviyo → Redo email parser working end-to-end. 415 templates tested (90% clean, 0 failures). Full pipeline: Klaviyo HTML → cheerio parse → Section[] → production renderer → HTML. Side-by-side comparison viewer built. EmailTemplate exporter outputs production-shaped MongoDB JSON. Next: demo to eng team, hook up to Redo API for live imports.

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
- `src/parser/index.ts` — **main parser**: Klaviyo HTML → Section[] (cheerio, deterministic)
- `src/parser/style-utils.ts` — inline CSS parsing (padding, colors, fonts, borders, social detection)
- `src/renderer/index.tsx` — **renderer entry**: Section[] → HTML (production MJML pipeline)
- `src/renderer/blocks/*.tsx` — production block components (copied from redoapp)
- `src/renderer/types.ts` — all Redo block types, enums, Hydrated<> wrapper
- `src/viewer.ts` — side-by-side comparison viewer (Klaviyo vs Redo, desktop/mobile toggle)
- `src/export-template.ts` — full EmailTemplate JSON exporter (production MongoDB shape)
- `src/screenshot.ts` / `src/screenshot-batch.ts` — Playwright visual comparison

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

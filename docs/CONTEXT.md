# mime

## Description
Automation project for manual processes Michael does at Redo. Primary target: Klaviyo → Redo email migration workflow, and improving Redo's existing HTML → JSON email parser.

## Status
Extractor layer working end-to-end. Tree-accurate flow topology achieved via Klaviyo `2025-10-15` API revision. Blocked on redoapp GitHub access for Track 1 (email forwarder improvement).

## Two tracks
- **current/** — improve Redo's production email forwarder (HTML → Redo block JSON). Lives in the redoapp monorepo (not yet cloned). Klaviyo corpus is the eval set.
- **future/** — React HTML drag-drop editor POC. Exploratory only; only matters if Redo ever pivots away from JSON-native.

## Tech stack
- TypeScript, Node ESM, `tsx` for execution
- `@anthropic-ai/sdk` (planned for translator)
- Playwright (planned for executor)
- Mermaid for flow visualization

## Key files
- `src/klaviyo.ts` — shared client (paginate, retry, revision `2025-10-15`)
- `src/extract-templates.ts` — pulls all email templates (JSON + HTML)
- `src/extract-flows.ts` — pulls flows with FULL definition (tree topology, branch conditions, metrics)
- `src/extract-campaigns.ts` — pulls campaigns with inline template HTML
- `src/extract-images.ts` — downloads and dedupes images referenced in templates
- `src/visualize-flow.ts` — renders a flow bundle as Mermaid flowchart + HTML viewer
- `plans/parallel-build.md` — task breakdown for parallel agent work
- `plans/v1-klaviyo-to-redo.md` — architecture plan

## Working data
- `migrations/test-account/` — Quikcamo's Klaviyo account
  - 388 templates
  - 49 flows (with tree topology)
  - 123 campaigns
  - 168 images

## Run
```
KLAVIYO_API_KEY=... MERCHANT=<name> npx tsx src/extract-templates.ts
KLAVIYO_API_KEY=... MERCHANT=<name> npx tsx src/extract-flows.ts
KLAVIYO_API_KEY=... MERCHANT=<name> npx tsx src/extract-campaigns.ts
MERCHANT=<name> npx tsx src/extract-images.ts
npx tsx src/visualize-flow.ts migrations/<name>/flows/<file>.json
```

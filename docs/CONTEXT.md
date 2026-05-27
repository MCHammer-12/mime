# mime

## Description
Automation project for manual processes Michael does at Redo. Primary target: Klaviyo → Redo email migration workflow, and improving Redo's existing HTML → JSON email parser.

## Status
End-to-end import pipeline running in production via the Replit-deployed migrate UI. As of **2026-05-28**:

- **Saved-template import path fixed (Saved Templates tab).** Standalone-template + campaign imports (`asSavedTemplate: true` → `createSavedEmailTemplate`) were 400ing (`template._id Invalid input`) then 500ing. The RPC embeds a full `EmailTemplate` whose Mongoose schema requires both `_id` and `team`, but the handler injects neither onto the embedded doc. `preparePayload` now keeps `_id` and injects `team` from the JWT `aud` claim (`decodeJwtAud`) for the saved path; `createEmailTemplate` path unchanged (`.omit({_id})` drops the extra `_id`). Failed template imports now also write `error.txt` into the troubleshoot bundle. PRs #62 / #63 (temp revert) / #64 (real fix).

As of **2026-05-26** (later same day):

- **CODE-template parser shipped fidelity batch.** Castle Sports' 3 `[EG]` abandonment flows were unusable — surface complaint was "no images," real cause was Zaymo-built CODE templates producing duplicated sections with stripped inline structure. Shipped on `fix/code-parser-fidelity` (PR #91, rebased over the earlier P0-only #112): container detection rewrite (Zaymo `<div id="bodyTable">` preference + regex bugfix + inline-`width:600` support + MSO-class skip), body-noise + `mso-hide:all` skip, Klaviyo URL variable substitution in button/image links via `classifyKlaviyoUrl`, image width preservation with asymmetric `<td align>` (mirror of `blocks/image.ts:67-74` pattern), `<br>` + `<span>` inline-structure preservation in deep-walker, post-pass SOCIALS-block collapse from icon-URL runs, asymmetric border-radius reviewItem heuristic. Otishi corpus: 4211 → 4151 sections (60 socials collapsed), 0 failures, warnings 141 → 62. All 8 Castle CODE templates parse with 0 failures + 0 warnings. Memory `project_code_template_parser` updated from "paused" to "shipped". See [`plans/2026-05-26-code-fidelity.md`](../plans/2026-05-26-code-fidelity.md).

As of **2026-05-26** (morning):

- **Font preflight gate replaces silent warn.** Templates / flows referencing fonts not on Google Fonts (Futura, proprietary Adobe faces, etc.) now pause the import with a `needs_input` modal that lists the missing families and re-checks the brand kit before prompting. User clicks "Continue (added them)" once the fonts are uploaded, or "Import anyway" for fallback rendering. Wired into both template and flow phases — the flow phase also gained its own `uploadFontsForTemplates` call, which was previously missing entirely. `questionKey` scoped by font set so new fonts in later phases re-prompt.
- **Parser duplicate-`<p>`-style fix.** `parseTextBlock` was prepending a fresh `style="text-align:…;line-height:…"` to every `<p>`, including ones with existing inline styles. Per HTML5 spec, browsers and Quill keep only the first `style` attribute and drop the rest — silently losing inline `font-family` declarations. Now merges into any existing attribute. Smoke test `src/parser/blocks/text.smoke.ts` locks in the behavior.
- **Feedback notes can be marked resolved.** `StoredNote` gains optional `resolvedAt` + `resolvedBy`. Per-item `✓ resolve` / `↺ reopen` button in the troubleshoot panel; resolved rows mute (opacity + strikethrough). `getJobNoteCount` drops resolved notes from the "Has feedback (N)" filter, per-card "N noted" badge, and `select noted` action so the to-do counter goes to zero after fixes ship. Text edits auto-reopen — new content is fresh work.
- **Jobs panel search + feedback filter.** Text input filters by store name (case-insensitive substring); counter switches `N total` → `N/M` while filtering. "Has feedback (N)" filter pill narrows to jobs with at least one note. Per-card "N noted" badge so review-worthy jobs scan at a glance. `select noted (N)` action pre-selects items with notes for one-click export.

As of **2026-05-14**:

- **Flow-imported templates inherit the flow's trigger schemaType** (was hardcoded `marketing_email`). Fixes back-in-stock / cart-abandonment / order-tracking / Yotpo flows so their trigger-specific dynamic variables (`productName`, `cartSubtotal`, etc.) actually appear as bindable in the editor.
- **NDJSON job stream has 10s heartbeat** — survives Replit proxy's idle-stream killer during the `needs_input` wait (modal open, no bytes flowing). Mirrors the existing `handleFlowsStream` pattern.
- **15 Order Tracking triggers + generic Reviews trigger** added to the trigger-picker (`marketing-trigger-options.ts` + `types.ts`). Operator can hand-pick when Klaviyo metric name doesn't auto-resolve. Auto-resolve mappings still TODO for live Reviews-app metric names like "Ready to review".
- **Bare `ANTHROPIC_API_KEY` accepted** (Replit's default Anthropic integration shape) alongside the older `AI_INTEGRATIONS_*` blueprint pair.

As of **2026-05-08**:

- **Klaviyo "Started Checkout" → Redo CART_ABANDONMENT** (was CHECKOUT_ABANDONMENT). Aligned with how merchants name "Abandoned Cart" flows in Klaviyo. Confirmed with Redo eng.
- **Migrated cart-deeplink buttons emit static `<storeUrl>/cart`**, not `linkType:dynamic-variable, schemaFieldName:checkoutUrl`. Redo eng confirmed `schemaInstance.checkoutUrl` is a Shopify Storefront cart URL that's silently null on cart-fetch failure — would hide the button entirely. `MappedLink.dynamic-variable` variant removed; `ParseContext.storeUrl` plumbed through. See `project_redo_checkout_url_resolution` memory.
- **Klaviyo `profile-marketing-consent` condition** ("is subscribed to SMS/email") translates to Redo's `customer_attribute` boolean dimension (`subscribed-to-sms` / `subscribed-to-email`).
- **Klaviyo "Ordered Product" metric** maps to `order-placed` (per-order, since Redo has no per-line-item activity).
- **SMS templates explicitly emit `autoShortenLinks: false`** (Redo mongoose default is `true`; absence of value = on by default, contrary to operator preference).
- **Merchant credentials moved from browser localStorage to Postgres** (`stores` table, migration 003). `GET /api/stores/:id` returns the full record for the edit form; `POST /api/debug/resolve-template` lets diagnostics tooling run resolver checks server-side. Dashboard cards get an edit pencil with JWT-expiry hint.
- **Resolver failures are typed** (`ResolveFailure` with six concrete reasons). Flow parser surfaces per-template warnings explaining why each blank fallback happened.

As of **2026-05-11**:

- **External assist surface at `/`:** branded "redo", per-assistant via `?as=Dennis` / `?as=Toby` URL. Brand-card picker → per-store items list with checkbox + note textarea. Drag-and-drop card priority is per-user. Notes round-trip back into the existing Toby troubleshoot panel via the same `jobs.notes` JSONB column.
- **Admin moved to `/<ADMIN_URL_TOKEN>/`** (obscure URL + HttpOnly cookie). First-visit modal claims an Austin or Michael slot via `admin_claims` (random token in DB mirrored to HttpOnly cookie). Both slots claimed = dashboard hard-locked; new browsers see disabled modal options and every admin API call returns 401. Reset only via psql.
- **Header nav** between surfaces — admin has "Assist ↗" (opens `/?as=<adminUser>`) and "View as Dennis/Toby" (preview mode, read-only); assist has "← Admin" link when `/api/me` says the requester is verified admin.
- **DB additions:** migrations 004-009 — `imported_items` (flat per-store list of imports), `email_count` column on it (drives Hours-saved tally), `assist_completions`, `stores.created_by`, `card_priority`, `admin_claims`.
- **"Hours saved: X" chip in admin header** — ceil(emails * 20min / 60) summed across all imports.

As of **2026-05-07**:

- **Email parser polish:** ancestor-walking bg detection (catches MJML section bg-divs / body bg); `New York` / `Baskerville` system fonts substitute to Georgia at parse; WCAG contrast guard auto-flips poor-contrast text + links to readable color; double-spaced (`line-height ≥ 1.7`) text simulates with `<br><br>`; split-block image padding falls through to td chain when no `td.spacer`; static product blocks emit a real Products block with `_pendingProducts` (importer-side Shopify name resolution required); adjacent same-shape Products blocks merge across intervening spacers/lines.
- **Flow parser polish:** drop-policy for un-translatable actions (update-profile / list-update / target-date / heavily-unmapped-webhook → drop + restitch chain, was WAIT stub); ab-test action → extract embedded `main_action` send-email; `{{ event.extra.responsive_checkout_url }}` → `checkoutUrl` dynamic variable; `person|lookup:"X"` Liquid → `customer_X`; `organization.name` substitution now applied to subject + preview (was email body only); 12 Yotpo Integration triggers (Loyalty + Reviews) supported with multi-alias METRIC_NAME_MAP entries.
- **SMS migration shipped:** Klaviyo `send-sms` → real `SendSmsStep` + `createSmsTemplate` RPC. Empty body fallback to WAIT stub for AI-content templates. MMS attachments deferred to v2 (drop with warning).
- **Saved templates split:** Standalone template imports + campaign imports now route through `createSavedEmailTemplate` RPC (lands in Saved Templates tab). Flow-attached templates stay as `createEmailTemplate` because `send_email.templateId` references EmailTemplate `_id`.
- **Troubleshoot bundle on failure:** failed flow imports now include `klaviyo-flow.json`, `parse-result.json` with the parsed automation we tried to send, and `error.txt` with the full Zod stack — was previously empty for failed flows.

Open: importer-side `_pendingProducts` resolution (redoapp `import-klaviyo-templates.ts` doesn't yet swap product names → `manuallySelectedProducts` via Shopify search); discount-code create+attach (blocks both email and SMS UX, parked pending redoapp design); Yotpo metric-name aliases need verification against Gaidama; Toby branch-config warnings + naming + end-as-message; image+product duplication, footer column text padding, bold inversion, GIF → 2 images + 2 text blocks (Roden Gray / nevermindall — most need fresh troubleshoot bundles); Replshield blocks `curl` to `/api/debug/resolve-template` (need either Michael logged-in via Chrome MCP or deploy made public); Klaviyo Reviews-app metric "Ready to review" not in `METRIC_NAME_MAP` auto-resolve (picker fires); pre-#61 imports still have wrong template schemaType (needs re-import).

Packages A-D + F (parser polish) + E1 (variable substitution) + E2 (inline coupon → AI rewrite + placeholder discount block) + E4 (REVIEW aggregator) complete. 416 templates in the local corpus parse with 0 failures. Import executor in redoapp (uncommitted) handles product filter creation.

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
- `src/migrate/bundle.ts` — per-job troubleshoot zip builder (Klaviyo source + Redo output + parse-result + notes). Streamed via `archiver` from `POST /api/jobs/:id/bundle`.
- `src/migrate/bundle.smoke.ts` — bundle smoke-test (point at a real corpus template, prints zip entry list).
- `src/flow/marketing-trigger-options.ts` — picker options for the trigger-recovery flow (mirrors Redo's marketing trigger list).
- `src/flow/parser.smoke.ts` — round-trip smoke test for `parseFlow(forcedTrigger: …)`.
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

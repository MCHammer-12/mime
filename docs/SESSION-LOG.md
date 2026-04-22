# Session Log

## 2026-04-21 — Package E3: font provisioning pipeline (mime side)

**Done**
- **`src/fonts.ts` (new):** `collectFonts(sections)` walks all block types — text + text.inline spans, button, discount, menu, header, products (incl. nested `checkoutButton` / `lineItemButtons` InlineButton), ColumnBlock recursion — returning deduped `FontUsage[]` with per-site usage. `resolveGoogleFont(family)` probes Google Fonts CSS2 API (no API key, modern UA for WOFF2). Literal-first casing with title-case fallback so "PT Sans" (brand mixed-case) and "OSWALD" (all-caps) both resolve. `buildFontPlan(sections)` combines collect + resolve into `{ entries, hasUnresolved }`.
- **`src/export-template.ts`:** attaches `_fontPlan` to the exported EmailTemplate (same non-prod convention as `_pendingFilter` on products). Prints per-font status in the export summary.
- **Corpus audit (804 templates):** 15 unique custom fonts. 7 resolve on Google Fonts (Alegreya Sans — 695 uses / 348 templates — Inter, Oswald, PT Sans, Pontano Sans, Bodoni Moda, Questrial). 8 don't (typos: "Alegrey extra", "potano sans", "TimesNewRoman"; weight-as-family aliases: "Alegreya sans bold"; Apple system fonts: "New York", "Baskerville").
- **Memory update (contradicted doc):** `reference_brand_kit_font_upload.md` previously said "migration script does NOT programmatically upload fonts". Reversed today — new path is auto-upload for Google-Fonts-resolvable, block-with-per-font-error for unresolvable. Rewrote the reference with explicit history, updated `project_migration_human_input_ux.md` touchpoint #6, updated `MEMORY.md` index entries.
- **Commit hygiene:** stashed E2's in-progress `transform.ts`/`ai-rewrite.ts` and E4's files before committing so `16c5378` contains only `src/fonts.ts` + `src/export-template.ts`. Restored stashed work after push.

**Files changed**
- `src/fonts.ts` (new, 272 lines)
- `src/export-template.ts` (import + `buildFontPlan` call + `_fontPlan` field + console output, +20 lines)
- Memory: `reference_brand_kit_font_upload.md` rewritten, `project_migration_human_input_ux.md` touchpoint #6 updated, `MEMORY.md` index entries updated

**Commits on `claude/trusting-carson`** (pushed)
- `16c5378` feat(fonts): E3 — Google Fonts resolver + `_fontPlan` emission

**Decisions**
- **Auto-upload with preflight-block fallback** (reverses 2026-04-14 preflight-only). Rationale: Google Fonts is the canonical source with OFL licensing — no ambiguity about what gets uploaded. If a font isn't on Google Fonts, importer still blocks with a clear per-font error. Best of both paths.
- **`_fontPlan` embedded per-template** (not aggregated at migration level). Importer aggregates across templates when it runs. Matches `_pendingFilter` convention.
- **Literal-first casing with title-case fallback** in the resolver — preserves brand casing like "PT Sans" while still recovering inconsistent casing like "OSWALD" → "Oswald". Brute-force normalization would break brand names.

**State at session end**
- Branch: `claude/trusting-carson`, pushed.
- Packages complete: A, B, C, D, F, E1, E2, **E3**, E4, G.

**Next steps**
1. **Redoapp-side E3** (new session): `~/code/redoapp/redo/manage/src/import-klaviyo-templates.ts` consumes `template._fontPlan` before `EmailTemplateRepo.createTemplate`: auto-upload resolved fonts via `uploadFile → processFontFiles → TeamRepo.updateBrandKit`, hard-fail per-font on unresolved, strip `_fontPlan` before saving. Mirrors existing `_pendingFilter → recommendedProductFilterId` swap pattern.
2. E5: drop-shadow CDN upload (or move `drop-shadow.png` to mime Replit deploy per `project_drop_shadow_asset_hosting` memory).
3. Merge `claude/trusting-carson` to main.

---

## 2026-04-21 — Package E2: inline coupon → AI text rewrite + placeholder discount block

**Done**
- **`src/ai-rewrite.ts` (new)** — portable `@anthropic-ai/sdk` client that works on Replit (`AI_INTEGRATIONS_ANTHROPIC_BASE_URL` + `AI_INTEGRATIONS_ANTHROPIC_API_KEY` env vars) and locally (`ANTHROPIC_API_KEY`) with zero code changes. Single concrete implementation — no `LLMClient` abstraction layer; the SDK is the abstraction.
- **Model: `claude-sonnet-4-6`** with system-prompt `cache_control: ephemeral`. System prompt is static across all rewrites in a migration → first call writes the cache (~1.25×), subsequent calls within 5 min read it (~0.1×).
- **System prompt** instructs the model to: (a) remove the `{% coupon_code %}` variable, (b) restructure the sentence so it flows into a discount block that will be inserted immediately below, (c) preserve all HTML tags/inline styles, (d) keep other liquid variables intact (`{{ person.first_name }}`, etc). Three few-shot examples in the prompt cover the most common phrasings.
- **`src/transform.ts`** — converted to async. Text-block handler now: (1) runs E1 variable substitution, (2) detects surviving `{% coupon_code %}` via `hasInlineCoupon`, (3) calls `rewriteInlineCoupon`, (4) emits `[rewrittenText, placeholderDiscountBlock]`. The placeholder DiscountBlock is styled from the text block's own fields (inherits `fontFamily`, `textColor`, `sectionColor`, `sectionPadding`) with `fontSize: 32`, `alignment: center`, no `discountId` (wired later in the import executor).
- **flatMap at the top level** (`for` loop building `out[]` with `push(...transformed)`) so a single input block can emit multiple output blocks. One-to-many `transformBlock` signature is the key change.
- **Column cells: intentionally skipped.** ColumnBlock holds a single block per column — can't splice a discount block as a sibling inside a column. Logs a console warning when detected; AI still rewrites the text in the cell.
- **Rule-based fallback when AI is off.** When `SKIP_AI=1` (or no API key set), `ruleBasedStripInlineCoupon` deterministically excises the common `"USE CODE {% coupon_code 'X' %} FOR N% OFF"` phrase and still emits a discount block. If the phrase doesn't match the regex, the coupon stays in the text (merchant cleans up manually) and a discount block is still appended. Every inline-coupon template produces a discount block whether or not the AI ran.
- **`src/export-template.ts`** — awaits the async transform, reports `aiRewrites` count + token usage (input / output / cache read / cache write) in the console summary.
- **`transformSections(sections, account | null, opts)`** — `account` can now be null (when Klaviyo API fetch fails or `KLAVIYO_API_KEY` is missing). Variable substitution gates on the presence of each org field; coupon detection + rewrite still run. Missing-key fallback no longer drops discount blocks entirely.

**Files created/changed**
- `src/ai-rewrite.ts` (new)
- `src/transform.ts` — async, coupon-rewrite pipeline, null-safe account, rule-based AI-off fallback
- `src/export-template.ts` — await transform, report AI usage
- `package.json` — `@anthropic-ai/sdk` dep added

**Decisions (see DECISIONS.md)**
- No `LLMClient` abstraction layer. Replit's "AI Integrations" is standard Anthropic SDK + auto-provisioned env vars — same code runs both places.
- Placeholder `DiscountBlock` from parser + transform does NOT carry `discountId`. Real discount object linking happens in the redoapp import executor, not in mime's export.
- Inline-coupon rewrite removes the variable AND always inserts a placeholder discount block below — single-path, deterministic structure. The text's AI rewrite assumes a block below; no branch for "maybe keep the variable".

**Verified**
- Dry run on `test-account/RfTv2d-cart-discount-1.html` (single-coupon, body-copy only) — `SKIP_AI`/no-key path emits rule-based strip + discount block cleanly; warnings suppressed; font plan still runs; section count goes from 10 → 11 (discount block inserted).
- Type-check (`npx tsc --noEmit`) — no new errors in `ai-rewrite.ts` / `transform.ts` / `export-template.ts`.

**Not done (deferred)**
- Live AI run — Michael holding the Anthropic key. All 4 inline-coupon templates (`RfTv2d`, `SvGNVx`, `XJkGxs`, `YyKZYQ`) ready to smoke-test once a key is available.
- Real Redo discount-object creation + `discountId` wiring. Out of scope: belongs in the redoapp import executor since it needs team-scoped API auth and a discount already exists.
- URL-param inline coupons (`href="...?discount={% coupon_code 'X' %}"` — observed in grid-pixel templates) not handled this pass. Separate liquid-substitution concern.

**Next steps**
1. User provides Anthropic key → run the 4 inline-coupon templates end-to-end, eyeball the rewrites in element-viewer.
2. If the Sonnet 4.6 output needs tuning: iterate the system prompt (more examples, stricter tone-preservation instructions).
3. Wire the discount-object creation step into the redoapp import executor (`~/code/redoapp/redo/manage/src/import-klaviyo-templates.ts`). Input: parsed `DiscountBlock` with no `discountId` + migration-config prefix + inferred amount. Output: `DiscountBlock` with real `discountId`.

---

## 2026-04-21 — Package E4: REVIEW list aggregator + two url-mapping gap fixes

**Done**
- **E4 aggregator** `src/migrate/review-variables.ts` (new): walks a templates dir, parses each, dedupes `ParseContext.reviewItems` by `variableName`, sorts by template count, runs an interactive `[M]apped / [U]nsupported / [S]kip / [Q]uit` loop. Persists decisions after each choice to `url-mappings-pending.json` (crash-safe). Idempotent — already-classified variables skip on re-run. `[M]` prompts for `schemaFieldName` with auto-suggested camelCase default.
- **readline note:** `readline/promises` + callback `rl.question()` both hang after the first prompt when stdin is piped (readline closes on stream end before buffered lines are consumed). Replaced with a line-queue prompter using `rl.on("line")` + queued waiters; returns `null` on EOF so the loop can bail cleanly. Relevant when writing any future interactive CLI in this repo.
- **Two real classifier gaps** surfaced by the aggregator and fixed in `src/parser/url-mapping.ts`:
  1. `CHECKOUT_URL_PATTERNS[0]` + `[1]` now allow optional Liquid filter suffix (`\|[^}]*`), matching `{{ event.URL|default:'' }}` → `checkoutUrl`. Previously only `event.extra.checkout_url` allowed filters.
  2. `UNSUPPORTED_VARIABLES` pattern `fulfillment.tracking_urls` → `tracking_urls?` so Shopify's singular `fulfillment.tracking_url` (single-shipment orders) also blocks.
- **`.gitignore`:** added `url-mappings-pending.json` (ephemeral; engineer folds entries into source).

**Verified**
- merchant-2 (27 templates): `event.URL` drops off review list.
- test-account (388 templates): `fulfillment.tracking_url` drops off; `email` (3 templates) + `order_status_url` (1 template) + `organization.url` (2 templates) remain as genuine unknowns needing a human decision.
- Batch regression across test-account + merchant-2 + merchant-3 (804 templates): 0 failures, 14 total reviewItems, 12 total unsupportedFeatures.

**Files changed**
- `src/migrate/review-variables.ts` (new, 313 lines)
- `src/parser/url-mapping.ts` (+6 -5)
- `.gitignore` (+1)

**Commits on `claude/trusting-carson`** (both pushed)
- `a540e5d` fix(url-mapping): allow Liquid filters in checkout patterns + singular tracking_url
- `d4ded27` feat(migrate): E4 REVIEW list aggregator

**Decisions**
- **No auto-mutation of `url-mapping.ts`** — aggregator writes to `url-mappings-pending.json`; engineer hand-folds entries into source as a follow-up edit. Matches `project_migration_human_input_ux` intent.
- **Pending file at repo root** (not per-migration), gitignored.
- **Surgical commits** — url-mapping.ts fix shipped ahead of the E4 script so parallel sessions (E2 ai-rewrite, E3 fonts) rebase cheaply.

**State at session end**
- Branch: `claude/trusting-carson`, pushed to origin.
- Packages complete: A, B, C, D, F, E1, G, **E4**.
- Parser: 804 templates parsed across 3 corpora, 0 failures.
- Concurrent in-flight (other sessions, uncommitted when I finished): E2 `src/ai-rewrite.ts`, E3 `src/fonts.ts` + export-template wiring.

**Next steps**
1. On a real migration, run `npx tsx src/migrate/review-variables.ts migrations/<account>/templates`, answer M/U prompts, then fold `url-mappings-pending.json` entries into `mapKlaviyoUrlToSchemaField` + `UNSUPPORTED_VARIABLES` as a follow-up PR.
2. Continue E2 (coupon → discount objects + AI rewrite), E3 (font provisioning), E5 (drop-shadow CDN upload).
3. Once E2/E3/E5 land: prod import test, then merge `claude/trusting-carson` to main.

---

## 2026-04-15 — End-to-end import fixes + Package F + E1 variable substitution

**Done**
- **Three import validation bugs fixed:** ObjectId blockIds (nested columns too), schemaType `marketing-email` → `marketing_email`, stale line block missing horizontalPadding/verticalPadding (already fixed in parser, just needed re-export).
- **Image/button placeholder support:** parser now emits empty ImageBlock (no src) and ButtonBlock (no `<a>`, reads `<p>` text) instead of silently dropping. Unblocks column-zipper for placeholder-heavy templates.
- **Stacked-column bail-out:** multi-col rows where each col has >1 block emit flat with a warning instead of zippering into stacked ColumnBlocks (breaks mobile reflow).
- **Package F (parser polish):** renamed `parseHeaderBlock` → `parseHeaderLogoAsImage`, aligned `ProductLayoutType` (`"grid"` → `"columns"`) and `ProductSelectionType` (`"manual"` → `"static"`) with prod enums. Confirmed F2 (line innerPadding), F4 (parsePadding cascade), F5 (MjmlSection padding audit) were already done.
- **E1: Footer variable substitution** via Klaviyo Accounts API. New `src/fetch-account.ts` + `src/transform.ts`. Post-parse pass substitutes `{% unsubscribe %}` → `{{ unsubscribe_link }}`, `{{ organization.name/full_address/url }}` → literal values from Accounts API. `export-template.ts` now async, accepts `KLAVIYO_API_KEY`.
- **merchant-3 extracted:** 388 templates from Klaviyo account `pk_8b9997b013419c24160c5a676da59f2c19` (QuikCamo).
- **Three templates imported end-to-end** into local redoapp team `Mime` (`69dff28302f64f42e6012a4d`): Newsletter #8 (Snack), Newsletter #4 (Story Boxes) x2 (before/after substitution). All pass Redo schema validation.
- **Confirmed deep-dive terminals had no unmerged work** — all on main, clean. TODO-SHARED files are the spec; per-element code changes were never implemented (only shared refactors A-D landed). Terminals safe to close.

**Files created/changed**
- `src/parser/helpers.ts` — ObjectId blockIds
- `src/parser/blocks/header.ts` — rename → parseHeaderLogoAsImage
- `src/parser/blocks/image.ts` — placeholder support
- `src/parser/blocks/button.ts` — placeholder support (no `<a>` fallback)
- `src/parser/blocks/column.ts` — stacked-col bail-out
- `src/parser/blocks/product.ts` — layoutType fix
- `src/parser/blocks/menu.ts` — doc comment update
- `src/parser/index.ts` — header rename ref
- `src/renderer/types.ts` — ProductLayoutType + ProductSelectionType aligned
- `src/export-template.ts` — async, schemaType fix, variable substitution wiring
- `src/fetch-account.ts` (new) — Klaviyo Accounts API client
- `src/transform.ts` (new) — post-parse variable substitution

**Decisions**
- Stacked multi-col → emit flat (not zipper). Mobile reflow breaks with stacked ColumnBlocks.
- Image/button placeholders: emit empty blocks (imageUrl="" / buttonLink="") with warnings, not drop silently.
- Variable substitution lives in transform.ts (post-parse), not in parser. Parser stays deterministic.

**State at session end**
- Parser: 416 templates, 0 failures, 341 warnings
- Packages complete: A, B, C, D, F, E1, G (import executor)
- Branch: `claude/trusting-carson` (3 commits ahead of main)
- Local redoapp running, team Mime has 4+ test templates

**Next steps**
1. E2: Coupon → Redo discount objects + AI text rewrite
2. E3: Font provisioning (Google Fonts → S3 → brand kit)
3. E4: REVIEW list aggregation (interactive variable classification)
4. E5: Drop-shadow CDN upload
5. Merge trusting-carson to main

---

## 2026-04-14 — Integration session: parser split, parallel element work, import path design

**Done**
- **Parser refactor** — split monolithic `src/parser/index.ts` into per-block modules under `src/parser/blocks/<type>.ts` with a thin dispatcher. Enabled parallel per-element deep-dive work across multiple terminals without merge conflicts.
- **Element-isolation viewer** — built `src/element-viewer.ts` that parses templates, filters to one block type, renders each matching block in its own card with JSON toggle. Redo-only (no Klaviyo side-by-side); user compares against the real Klaviyo UI independently.
- **Parallel element deep-dives** (across ~10 terminals): text, image, button, header, menu, line, spacer, socials, column, discount, products, klaviyo-specific (video/preview-quote/drop-shadow). Each terminal wrote its own session log + TODO-SHARED note.
- **Shared-file refactors (Packages A+B+C+D) landed:**
  - `6d76162` — Upstreamed `parsePadding` shorthand override bug fix into `src/parser/style-utils.ts`
  - `9375c37` — Replaced string-prefix warning convention (`REVIEW:`, `UNSUPPORTED:`, `SKIPPED:`) with structured `ParseContext` fields
  - `3bea718` — Hoisted Klaviyo URL classifier into `src/parser/url-mapping.ts` for reuse across button/image/menu/socials
  - `caf90ad` — Aligned `src/renderer/types.ts` with prod Zod schemas (PRODUCTS enum, Size, horizontalPadding/verticalPadding, showCaption, lineHeight/textAlign, removed SocialIconColor.ORIGINAL)
- **TODO-SHARED complete for all 12 elements** — wrote missing files for image, line, header, menu, socials, spacer, column. Previously existed for button, discount, klaviyo-specific, product, text.
- **Consolidated work plan** — `plans/consolidated-todos.md` groups all per-element TODOs into 8 work packages (A–H) with dependencies and parallelization guidance.
- **Import executor scaffolded** — `~/code/redoapp/redo/manage/src/import-klaviyo-templates.ts` (216 lines, uncommitted in redoapp) using `ArgumentParser`, `TeamRepo`, `ProductFilterRepo`, `EmailTemplateRepo`. Handles `_pendingFilter` → `recommendedProductFilterId` swap.
- **Track 4 (polish)** kicked off in parallel terminal.
- **Local redoapp setup** initiated in separate terminal to enable end-to-end testing against a local MongoDB + running redoapp web/api. Setup documentation being written to `docs/SETUP-local-redoapp.md`.
- **Human-input UX design** — walked through all 8 merchant-input touchpoints and locked decisions (see DECISIONS.md + `project_migration_human_input_ux` memory): store ID (CLI flag), discount prefix (default "RE"), discount amount/type (trust+prompt ambiguous), org name/address (Klaviyo API→confirm), image-as-button (strip+flag), fonts (preflight block, no upload), URL variables (interactive M/U/S prompts), static products (Shopify resolver with Column fallback).
- **Research validated:** Klaviyo→Redo template import path (`EmailTemplateRepo.createTemplate` via `redo/manage` script, modeled on `copy-template-to-teams.ts`); brand kit font upload API (scriptable but deferred); Shopify product resolution (live `ShopifyProvider.searchProducts` GraphQL, no cache needed); team vs store ID (same ObjectId, different user-facing term).

**Files created/changed**
- `src/parser/index.ts` — dispatcher-only refactor
- `src/parser/helpers.ts` (new)
- `src/parser/style-utils.ts` — parsePadding shorthand fix
- `src/parser/url-mapping.ts` (new) — hoisted classifier, mapKlaviyoLink, UNSUPPORTED_VARIABLES
- `src/parser/blocks/*.ts` — 12 per-element parsers (new from split)
- `src/parser/blocks/TODO-SHARED-*.md` — per-element follow-up notes (complete set of 12)
- `src/parser/batch-test.ts` (new) — batch regression check
- `src/renderer/types.ts` — aligned with prod Zod
- `src/renderer/blocks/*.tsx` — updated per element deep-dives
- `src/element-viewer.ts` (new)
- `plans/element-deep-dive.md` (new)
- `plans/consolidated-todos.md` (new)
- `~/code/redoapp/redo/manage/src/import-klaviyo-templates.ts` (new, uncommitted) — import executor scaffold
- Memory: `reference_template_import_path`, `reference_team_store_id`, `reference_brand_kit_font_upload`, `project_klaviyo_blocks_not_in_redo`, `project_migration_human_input_ux`

**Decisions (see DECISIONS.md)**
- Static product blocks: Shopify GraphQL handle resolver with Column-of-Images fallback (supersedes earlier "static→Column only" decision)
- AI-minimal pipeline (AI only for inline coupon sentence rewriting; everything else deterministic+prompts)
- Font provisioning: preflight-block, no programmatic upload
- "Store ID" is the user-facing term; internal code uses `team`

**State at session end**
- Parser: 416 templates parsed, 0 failures (warnings 312, down from 322 before refactor)
- Packages complete: A, B, C, D
- Package G: scaffolded in redoapp, not yet tested against live DB
- Package H (polish): running in parallel terminal
- Package E (AI migration pipeline): deferred until G + local redoapp setup complete
- Local redoapp setup: in progress in separate terminal

**Next steps**
1. Let Track 4 (Package H polish) complete and merge
2. Let local redoapp setup complete; verify `bazel build //redo/manage:import-klaviyo-templates` succeeds
3. Seed a test team in local Mongo, run the import script against it with a small migration (e.g. `merchant-2`, 27 templates)
4. Open imported templates in the local Redo builder UI; verify rendering matches the local viewer
5. Iterate on any discrepancies
6. Once local end-to-end works: PR the import executor to redoapp, run against a real test team in prod
7. After prod path is proven: start Package E (migration pipeline — AI + variable substitution + discount objects + font preflight + Shopify resolver for static products)

---

## 2026-04-14 — Products block (interactive-cart) deep-dive

**Done**
- Rewrote `src/parser/blocks/product.ts`: now branches on static vs dynamic. Static (hardcoded URLs, no liquid `feeds.` variables) keeps the existing COLUMN-of-images decomposition with a warning. Dynamic (liquid `{% if feeds.|index:N %}` + `{{ item.* }}`) emits a full `interactive-cart` block with styling extracted from the Klaviyo cell: title font/size/color, image corner radius + size bucket (small ≤100 / medium ≤150 / large from `max-height`), button styling (fill, stroke, corner radius, padding, font) reused for both `lineItemButtons` and `checkoutButton`, columns from cell width %, `numberOfProducts` from cell count, `showPrice/Title/Image/Button` detected from liquid var presence.
- Added a document-level cart-context detector (`CART_CONTEXT_LOOP_RE` scanning the template for `{% for <x> in (event.extra.line_items|items) %}`) memoized per `$` via WeakMap. On hit → `Cart Item` filter default (`products_added_to_cart`, sort price desc, last 90 days, inventory > 0) + `schemaFieldName: "cartContext"`. Otherwise → `Best Sellers` default (random sort via omitted `sortBy`, inventory > 0).
- Parser output carries a non-prod `_pendingFilter: ProductFilterDoc` on the block. The (not-yet-built) executor will POST this to `https://app-server.getredo.com/marketing-rpc/createProductFilter` and swap the returned `productFilterId` into `recommendedProductFilterId` before creating the template.
- New placeholder renderer `src/renderer/blocks/product.tsx` draws an N-cell grid styled per the block's own extracted title/button styling — enough to eyeball the layout in the element viewer. Registered in `src/renderer/index.tsx` componentMap under the `"interactive-cart"` string key (widened map type to `Record<string, …>`).
- Element viewer now filters `product` by `"interactive-cart"` instead of `COLUMN`.
- Verified on `merchant-2/H76ZS6-newsletter-4-story-boxes` (3×3 dynamic grid, Best Sellers pending filter, extracted Helvetica Neue / 14px / #3d3935 / #1155cc button / cornerRadius 5 / sectionPadding {9,18,9,18}) and static fallback still works on `test-account/QPETZp-flow-template` (4 decomposed COLUMNs + warnings).

**Files changed**
- `src/parser/blocks/product.ts` (rewritten)
- `src/parser/blocks/TODO-SHARED-product.md` (new)
- `src/renderer/blocks/product.tsx` (new)
- `src/renderer/index.tsx` (+1 import, +1 map entry, widened map type)
- `src/element-viewer.ts` (typeMap `product` → `"interactive-cart"`)
- Memory: `project_products_block_mapping.md` + MEMORY.md hook

**Decisions**
- Dynamic-only for MVP; static decomposition preserved as warning-generating fallback. See DECISIONS.md entry.
- Filter defaults selected from template HTML alone (Klaviyo Templates API does not expose block-level feed config). Collection-based filters cannot be derived automatically — user must retarget after import.

**Next steps**
1. Executor work (when the redo/manage import script is built per `reference_template_import_path` memory): wrap `createProductFilter` POST → `EmailTemplateRepo.createTemplate` so `_pendingFilter` → `recommendedProductFilterId` swap happens at import time.
2. Confirm unresolved enum values in Redo editor: `imageSize` bucket thresholds, `layoutType` value for multi-col. Currently guessed.
3. When `types.ts` freeze lifts: add `EmailBlockType.PRODUCTS`, `ProductsBlock`, `InlineButton`, `ProductImageSize`, `ProductLayoutType`, `ProductSelectionType` per `TODO-SHARED-product.md`; revert `componentMap` type widening.

---

## 2026-04-14 — Footer block deep-dive (reversed — keep as Text)

**Done**
- Prototyped Footer block end-to-end: `src/parser/blocks/footer.ts` detecting `kl-text` tds containing `{% unsubscribe %}`, `src/renderer/blocks/footer.tsx` as an MJML analogue of prod `EmailFooter`, dispatcher wire-in in `src/parser/index.ts`, `componentMap` wiring in `src/renderer/index.tsx`, and `element-viewer.ts` typeMap entry.
- Confirmed extraction correctness on 3 templates (QZCq6B, YchdbL, Sz3XHM): font/color/padding round-trip fine, inner `<div class="textbody">` overrides picked up (Pontano Sans 12px in 2/3).
- **Reversed the decision after reviewing the rendered footer preview.** Prod FooterBlock forces its own copy/order ("business name / address / Unsubscribe") and destroys Klaviyo's preamble ("No longer want to receive these emails?"). Text block is strictly better: preserves original copy/order verbatim and Redo accepts `{{ unsubscribe_link }}` inline in Text `text` fields (verified via `hasUnsubscribeLink` in `redo/web/.../unsubscribe-link-warning-modal.tsx`).
- Deleted footer parser/renderer/TODO files, reverted all dispatcher/componentMap/typeMap wire-ins.
- Rewrote `TODO-SHARED-text.md` PRIORITY 0 with the new plan: export pipeline substitutes `{% unsubscribe %}` → `<a href="{{ unsubscribe_link }}">unsubscribe</a>`, `{{ organization.name }}` → merchant-provided org name, `{{ organization.full_address }}` → formatted merchant address. Org data sourced from Klaviyo Accounts API, falling back to user prompt — placeholders not acceptable.

**Files changed**
- `src/parser/blocks/TODO-SHARED-text.md` (PRIORITY 0 rewritten)
- Memory: `project_klaviyo_footer_variables.md` + MEMORY.md hook updated to reflect reversal

**Files created then deleted**
- `src/parser/blocks/footer.ts`
- `src/renderer/blocks/footer.tsx`
- `src/parser/blocks/TODO-SHARED-footer.md`

**Decisions**
- Keep footer-style text blocks as TextBlock; do NOT convert to Redo's FooterBlock. See DECISIONS.md entry.

**Next steps**
1. Implement the migration-pipeline text substitution (export-pipeline work, not parser).
2. Pull org name + address: try Klaviyo Accounts API first, fall back to user prompt; store in `manifest.json` under `account` key.
3. Audit for non-`{% unsubscribe %}` patterns (`<kl:unsubscribe-link>`, raw unsubscribe URLs) once full template corpus is available.

---

## 2026-04-14 — Discount block deep-dive

**Done**
- New parser `src/parser/blocks/discount.ts` exports `tryParseDiscountFromText`. Given a `kl-text` TD, it scans the inner HTML for standalone `{% coupon_code 'Name' %}` variables (bounded by `<br/>` or string edges) and splits the text block into `[text before, discount, text after, ...]` — multiple coupons per block handled.
- Inline mid-sentence coupons (e.g. "Just use code {% coupon_code %} at checkout") are intentionally left in the text block for the downstream AI-rewrite pass; they never produce a discount block from the deterministic parser.
- Style cascade is innermost-wins: coupon's immediate `<span style=...>` → inherited open wrappers (via a small tag-stack walk) → outer text-block div. This correctly picks up nested `text-align: center` and wrapping-span `font-family: Alegreya Sans` even when the outer div is `text-align: left` / `Helvetica Neue`.
- Wired into the dispatcher (`src/parser/index.ts`) between the footer check and the normal text parser. When the discount splitter returns a non-null array we push those blocks and skip the text parser for that wrapper.
- Renderer (`src/renderer/blocks/discount.tsx`) now falls back to `"XXXXXX"` when `props.discountCode` is undefined outside the builder env — so parser preview shows a visible placeholder instead of an empty block.
- Verified against RyMuGA-2 (standalone, single `<br/>` bounds) and XvRVJY-2 (standalone, `<br/><br/>` bounds) via `src/element-viewer.ts discount …`. Batch parser green: 415 templates, 0 failures.

**Files changed**
- `src/parser/blocks/discount.ts` (new)
- `src/parser/blocks/TODO-SHARED-discount.md` (new)
- `src/parser/index.ts` (wiring — 1 import + 5-line dispatch)
- `src/renderer/blocks/discount.tsx` (XXXXXX fallback)

**Decisions**
- Split into separate blocks (text + discount + text) rather than a text/discount "hybrid" block. Confirmed by Michael: this matches `project_coupon_to_discount.md` — Redo has no inline coupon primitive, so the discount must be its own block with an associated Redo discount object. The "hybrid" idea was considered but not chosen.
- Klaviyo coupon name (e.g. `"AbandonedCheckout"`) is **not** stored on the parsed DiscountBlock. Per project memory, the downstream flow generates a real Redo discount using a user-provided prefix + AI-inferred amount/type; the Klaviyo name isn't the mapping key.
- Inline coupons are not touched by this terminal — they stay in the text block until the migration's AI-rewrite pass runs.
- Discount blocks are rare in the Klaviyo dataset (only 2 of 415 test templates produce one with standalone coupons), so rare-case correctness was prioritized over coverage.

**Next steps**
1. Implement the migration-layer transforms referenced in `project_coupon_to_discount.md`: (a) discount object creation via Redo API with user-supplied prefix, (b) LLM rewrite of text blocks containing inline coupons.
2. Consider whether `stripStandaloneCoupons` in `blocks/text.ts` can be deleted once the splitter has proven coverage — it's now redundant for standalone cases but harmless as a safety net.

---

## 2026-04-14 — Menu block deep-dive

**Done**
- Fixed `parseMenuFromHeader` across H76ZS6, Hda2jD, K4ca2Z (all 1-item HLBs) plus multi-item examples YjRTWe and X57xAh (3 items each).
- `sectionPadding` now extracted from `hlb-block-settings-content` (was hardcoded `{0,0,0,0}`, causing horizontal misalignment with the sibling logo image). Top zeroed when an `hlb-logo` sibling exists so the split image+menu sections don't double up vertical padding.
- Iterate per `kl-hlb-wrap` wrapper instead of `.find("a")` across the whole wrapper block — pairs each item with its own alignment attribute.
- `alignment` now read from the wrapper's `align` attribute (was hardcoded `CENTER`).
- Font-weight, font-style, and text-decoration extracted from link inline style and encoded into label HTML as `<strong>`/`<em>`/`<u>` wrappers (bold = weight ≥ 600 or "bold"/"bolder").

**Files changed**
- `src/parser/blocks/menu.ts`

**Decisions**
- Font-weight / italic / underline carried via Quill-style inline tags in label HTML since `MenuBlock` schema has no `fontWeight` field.
- Didn't wire up `itemSpacing` / `useCustomSpacing`. Klaviyo's `mso-padding-alt` + `<a>` `padding` describes per-link internal padding (button-styled link), not inter-item gap. Redo's itemSpacing would subtract from section padding and shift the text, degrading alignment. Leave unset.
- Only 2 of 388 test templates have true multi-item menus — most Klaviyo HLBs in this dataset are logo + single CTA link.

**Next steps**
1. Consider Header/Menu consolidation — some HLBs might be better represented as a Header block (logo) + Button block (single CTA) rather than Image + 1-item Menu.
2. If a menu-only HLB (no logo) shows up, verify top padding applies correctly (code path exists but untested).

---

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

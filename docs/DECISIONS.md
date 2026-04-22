# Decisions

## 2026-04-21 — Drop-shadow asset hosted from Replit, not Redo CDN
The Klaviyo `bottom_shadow_*.png` → Redo Image block conversion in `klaviyo-specific.ts` needs a public URL the asset gets served from. Two options weighed: (a) upload to Redo's prod S3 / `assets.getredo.com` via the `@redotech/s3` `uploadFile` flow used by existing `redo/manage/src/support/upload-shopper-ai-wrapped-images.ts` scripts, or (b) bundle `pics/drop-shadow.png` into mime's Replit deploy and serve it from there. Picked (b): mime is deploying to Replit anyway (per `project_deployment_target_replit`), Replit Static Deployments give a stable `https://<subdomain>.replit.app/<path>` URL with no cold-start, free for tiny bandwidth, and avoid the friction of writing to Redo's prod buckets from outside redoapp. Implemented as `DROP_SHADOW_URL = process.env.DROP_SHADOW_URL ?? "https://PLACEHOLDER.replit.app/drop-shadow.png"` so the deploy-time switch is a single Replit Secret with no code change. Runtime guard (throw if still PLACEHOLDER) is open work — see TODO-SHARED-klaviyo-specific.md Priority 0.

## 2026-04-20 — CODE-template parser: built, paused at insufficient visual fidelity
Klaviyo `editor_type: CODE` templates (hand-coded HTML, no `kl-*` classes)
were a known coverage gap — Otishi has 368 of 464 templates in CODE mode.
Built a deterministic parser (`src/parser/code-template.ts`) covering two
structural dialects: table-based (600px table wrapper, `<tr>` rows as
sections) and div-based (Hypermatic/Stripo/MSO-wrapped, DFS deep-walk).
Batch run: 368/368 parse, 0 failures, 0 empty, 4211 sections.
Block detection (images, buttons, text, lines, columns) works; a real
end-to-end push to local Mime team succeeded and renders the right
structure. **But** visual fidelity in the Redo builder is insufficient
to ship — logo widths collapse to full-width (ImageBlock has no px field,
only `horizontalPadding: small|medium|large` buckets), column gaps
diverge from originals that rely on `border-radius` corner-joining
tricks, and per-span text styling inside a `<td>` is flattened. Each
issue is solvable but requires its own investigation against the Otishi
corpus. Decision: park the feature. Code is committed behind the
`editor_type: CODE` / no-kl-class heuristic so it's inert for existing
block-editor migrations. Picked back up when CODE migrations become a
blocker (likely Otishi onboarding). See `project_code_template_parser`
memory for the detailed state, warnings breakdown, and next-step queue.
## 2026-04-21 — Package E2: single-path inline-coupon transform, no LLMClient abstraction
Klaviyo inline `{% coupon_code 'X' %}` in body copy has no Redo equivalent. The transform now unconditionally rewrites the sentence and inserts a placeholder `DiscountBlock` directly below — single deterministic structure, no branching on "maybe keep the variable". The AI rewrite is written against that invariant ("a discount block will be inserted below") so prompt output is predictable. When AI is off (`SKIP_AI=1` or no API key), a rule-based regex strips the common `"USE CODE X FOR N% OFF"` phrase; if the phrase doesn't match, the Jinja tag stays in the text and a discount block is still appended, so every inline-coupon template produces a discount block either way. Column cells are the one exception: `ColumnBlock.columns` is one slot per column, so inserting a sibling discount block isn't possible — we rewrite the text but log a warning and skip the insertion. The Replit deployment detail (auto-provisioned `AI_INTEGRATIONS_*` env vars) means the stock Anthropic SDK works on both Replit and locally with a single `new Anthropic({ baseURL, apiKey })` instantiation — no `LLMClient` wrapper needed; the SDK *is* the abstraction. Discount-object creation + `discountId` wiring stays in the redoapp import executor (team-scoped API auth, discount already exists in the merchant's Redo account).

## 2026-04-15 — Teammate access: local-only for now, Replit + proper OAuth deferred
The mime pipeline runs locally (`npx tsx`) against local redoapp for dev/test. Long-term plan is to deploy on Replit (AI ops team preference; paid plan available) with proper "Login with Redo" OAuth so teammates can import directly to prod via `https://app-server.getredo.com/marketing-rpc/createEmailTemplate`. Researched Redo's marketing-rpc endpoints — they require a merchant JWT signed by Redo's server-auth keys; no API key/PAT scheme. Three access options were weighed (A: ZIP download, B: paste JWT from localStorage, C: proper OAuth). Decision: Option C (proper OAuth) is the eventual target; do nothing for now. Teammates who need to migrate can either set up local redoapp themselves (see `reference_local_setup_gotchas`) or hand off extracted templates to Michael for local import. Full plan captured in `project_replit_deploy_plan` memory so the work can be picked up cold in a future session.

## 2026-04-14 — Static product blocks: hybrid with Shopify GraphQL resolver (revised)
The earlier "dynamic-only MVP" decision left static product blocks decomposed as a ColumnBlock of ImageBlocks. New data: static blocks are ~50% of Quikcamo's product-containing templates (170 of 331), and ~74% (126) of those link to Shopify URLs with extractable product handles. Revised: the executor resolves static product handles to Shopify productId/variantId via the merchant's existing Shopify GraphQL connection (ShopifyProvider.searchProducts), builds a real PRODUCTS block with `productSelectionType: "manual"` + `manuallySelectedProducts`, and falls back to Column of Images only when the lookup fails (product deleted, non-Shopify URL, or handle mismatch). No separate cache — live Shopify query per handle, batched for rate limits. Post-import report flags fallbacks for merchant review. Research confirmed Shopify access is available from `redo/manage/` scripts via `ShopifyProvider` with the team's stored access token.

## 2026-04-14 — AI-minimal migration pipeline
Originally planned to use AI for: inline coupon sentence rewrites, discount amount inference, image-as-button detection, font ambiguity resolution. Revised to AI-minimal: the only remaining AI use is inline coupon sentence rewriting (where LLM genuinely outperforms regex/prompts). All other touchpoints use deterministic rules + user prompts at the config/preflight phase. Rationale: user prompts are fine for the handful of discounts and fonts per migration; AI introduces cost, latency, and silent-error risk that isn't justified for low-volume merchant input. See `project_migration_human_input_ux` memory for the 8 human-input touchpoints.

## 2026-04-14 — Font provisioning: preflight block, no programmatic upload
Research confirmed we CAN programmatically upload fonts to the merchant's Redo brand kit (`uploadFile` → `processFontFiles` RPC → `TeamRepo.updateBrandKit`). Decision: don't. Instead, the import script preflights the merchant's existing brand kit against the fonts required by the parsed templates; if any are missing, it blocks migration and prints an actionable list (font name, template count, Google Fonts URL where available, link to merchant's brand kit page). Rationale: no surprise uploads to the merchant's brand kit, no silent fallbacks that degrade visual fidelity, merchant retains full control. Idempotent: merchant adds fonts, re-runs script, preflight passes, migration proceeds. Documentation of the programmatic path kept in `reference_brand_kit_font_upload` memory for future use (e.g. a self-serve merchant-facing migration tool).

## 2026-04-14 — Store ID is the user-facing term for team ID
Redo's data model uses `team: ObjectId` internally (see `EmailTemplate.team`, `TeamRepo`). The merchant dashboard URL bar shows `/stores/<id>/...`. Decision: CLI flags + user-facing prompts use "store ID"; internal code passes it as `team`. They're the same MongoDB ObjectId. Avoids merchant confusion ("what's my team ID?" has no answer; "what's my store ID?" is the URL).

## 2026-04-14 — Products block: dynamic-only MVP, filter defaults inferred from template HTML
Klaviyo `kl-product` blocks come in two flavors: static (hardcoded image URL + title + CTA, typically pointing at Amazon or stored Shopify URLs) and dynamic (liquid `{% if feeds.|index:N %}` + `{{ item.* }}` driven by a Klaviyo server-side product feed). Redo's `interactive-cart` block expects `productSelectionType: "dynamic"` with a `recommendedProductFilterId` pointing to a separately-created `ProductFilter` document, or `"manual"` with explicit `{ productId, variantId }` pairs in `manuallySelectedProducts`. Decision: MVP handles dynamic only — parser emits full `interactive-cart` with a `_pendingFilter: ProductFilterDoc` that the executor POSTs to `createProductFilter` and swaps for an ID before writing the template. Static blocks keep the existing COLUMN-of-images decomposition with a warning, because resolving static URLs → Shopify product IDs is a separate, deferred concern.

Filter defaults are chosen from template HTML alone because **Klaviyo's Templates API does not expose block-level feed config** — only rendered HTML with liquid tags. Heuristic: if the template anywhere contains `{% for <var> in (event.extra.line_items|items) %}`, use the Cart Item filter (`products_added_to_cart`, sort price desc, last 90 days, inventory > 0) and set `schemaFieldName: "cartContext"` on the block. Otherwise use the Best Sellers filter (`best_sellers`, sort random via omitted `sortBy`, inventory > 0). Collection-based filters cannot be inferred from HTML and will silently get the default — the importer must surface per-template warnings so Michael can retarget manually after import. `imageObjectFit: "cover"` and `imageAspectRatio: undefined` (Auto) chosen as defaults per Michael.

## 2026-04-14 — Footer: keep as Text block, don't use Redo's FooterBlock
Klaviyo footers are text blocks containing `{% unsubscribe %}` and `{{ organization.* }}`. Original plan (per `project_klaviyo_footer_variables.md` and `TODO-SHARED-text.md` PRIORITY 0) was to convert them to Redo's `FooterBlock` with `schemaFieldName: "unsubscribeLink"` and `useTemplateAddress: true`. Prototyped end-to-end, but reversed after viewing rendered output: FooterBlock forces its own fixed copy/order ("business name / address / city-state-zip / country / Unsubscribe") with no configurable preamble, destroying Klaviyo's phrasing ("No longer want to receive these emails?") and merchant customization. Decision: keep as TextBlock and substitute the variables inline in the export pipeline — `{% unsubscribe %}` → `<a href="{{ unsubscribe_link }}">unsubscribe</a>` (Redo recognizes `{{ unsubscribe_link }}` inside text per `hasUnsubscribeLink` in web email-builder utils), and org variables → merchant-provided values from Klaviyo Accounts API (or user prompt fallback). Placeholder text is unacceptable — if API call fails, migration must prompt before proceeding. No new block type; no FooterBlock added to `types.ts`. Abandoned files: `src/parser/blocks/footer.ts`, `src/renderer/blocks/footer.tsx`.

## 2026-04-14 — Discount: split text block, not a hybrid
Klaviyo `{% coupon_code 'Name' %}` can appear either standalone (its own line between `<br/>`s) or inline in a sentence. Redo has no inline coupon primitive — a coupon must be its own DiscountBlock with an associated Redo discount object. Decision: deterministic parser handles standalone coupons only, splitting the surrounding text block into `[text, discount, text]`; inline coupons are left in the text block for the migration's downstream AI-rewrite pass to handle. Michael explicitly confirmed this over a "text/discount hybrid" block, which was considered and rejected because the prod schema offers no such hybrid.

## 2026-04-14 — Socials icon color: lossy mapping to prod enum
Prod Redo's `SocialIconColor` enum allows only `black`/`white`/`gray`. Local `types.ts` still lists `original` but it fails prod Zod validation. Klaviyo's `/default/` CDN path serves colorful branded icons with no exact Redo equivalent. Decision: `/default/` → `black`. Michael confirmed exact icon color match is not required for migrations as long as background, URLs, and padding are correct.

## 2026-04-14 — Klaviyo hlb-wrapper → Redo ImageBlock (not HeaderBlock)
Klaviyo's Header/Logo Bar (`hlb-wrapper`, used by 91% of templates) combines a logo image with optional menu links. Redo has a native `HeaderBlock`, but it auto-pulls the logo from the team's brand kit — unreliable for migrations where the brand kit may not be set. Decision: `parseHeaderBlock` emits an `ImageBlock` for the logo portion (width preserved via calculated horizontal inner padding so a 300px Klaviyo logo renders at ~300px in the 600px Redo email), and `parseMenuFromHeader` separately emits a `MenuBlock` for nav links. The `header.tsx` renderer is now dead code for Klaviyo migrations.

## 2026-04-08 — Klaviyo API revision: `2025-10-15`
The `additional-fields[flow]=definition` param, which returns the full flow graph with edges and branch conditions, is only accepted on revision `2025-10-15` or later. Earlier revisions (including the "current stable" 2024-10-15) return `additional-fields must be in []: (got definition)`. Shared client pinned to `2025-10-15`.

## 2026-04-08 — HTML-only translation path
Klaviyo's template API exposes the flattened `html` of drag-drop templates, not the block JSON (`editor_type: SYSTEM_DRAGGABLE`/`USER_DRAGGABLE`). There is no block-to-block mapping shortcut. Any translator to Redo JSON must parse HTML (LLM-assisted).

## 2026-04-08 — Campaign templates are inline, not cross-referenced
Campaign-scoped template clones do NOT appear in the `/templates/` listing endpoint. The Task G normalizer (future) must pull template data from campaign bundles directly for campaigns, and from `templates-manifest.json` only for flows.

## 2026-04-08 — Two-track project structure
Track 1 (production): improve the existing Redo email forwarder with an LLM parser. Track 2 (exploratory): React HTML drag-drop POC. A full rewrite to HTML-native (GrapesJS) or MJML is NOT on the critical path — Track 1's experiment determines whether it's needed.

## 2026-04-08 — Don't screen-scrape Klaviyo
We confirmed the public API returns the full topology, so reverse-engineering the web UI (Playwright + network intercept) is no longer needed. Branch edges, conditions, trigger metrics, profile filters, and email content all come from the public `definition` field.

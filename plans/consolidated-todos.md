# Consolidated TODO Analysis

All per-element TODOs are documented in `src/parser/blocks/TODO-SHARED-<element>.md`. This document groups them into **work packages** — items that share a root cause, a file, or a technical approach and should be tackled together to minimize rework.

---

## Work Package A — Warnings system refactor

**Root cause:** Per-element parsers currently use string-prefix convention (`UNSUPPORTED:`, `REVIEW:`, `SKIPPED:`) on the shared `warnings: string[]` array. This piggy-back was introduced because `src/parser/index.ts` was frozen during parallel work.

**Scope:** Replace with structured fields on `ParseResult`.

**Affects:**
- `src/parser/index.ts` (dispatcher — `ParseResult` type)
- `src/parser/blocks/button.ts` (remove prefix convention, push to arrays)
- `src/parser/blocks/klaviyo-specific.ts` (remove prefix convention)
- `src/parser/blocks/discount.ts` (if it uses warnings)
- `src/parser/blocks/image.ts` (when URL classifier lands — Package B)
- Downstream: migration script reads the structured arrays (Package G)

**From TODOs:** `TODO-SHARED-button.md` Priority 0, `TODO-SHARED-klaviyo-specific.md` Priority 1.

**Estimated effort:** small — mostly mechanical.

**Blockers:** none.

---

## Work Package B — Cross-block URL classification

**Root cause:** `mapKlaviyoLink` + the three-state classifier (`classifyVariable`, `extractVariableName`, `UNSUPPORTED_VARIABLES`) live inside `button.ts` but are needed by any block that carries a URL.

**Scope:** Hoist into `src/parser/url-mapping.ts` and call from every URL-carrying block.

**Affects:**
- `src/parser/url-mapping.ts` (add `classifyVariable`, `extractVariableName`, `UNSUPPORTED_VARIABLES`)
- `src/parser/blocks/button.ts` (import from url-mapping, delete local copy)
- `src/parser/blocks/image.ts` (call on `clickthroughUrl`)
- `src/parser/blocks/menu.ts` (call on menu item hrefs)
- `src/parser/blocks/socials.ts` (call on social URLs — low impact, socials rarely use variables)
- `src/parser/blocks/header.ts` (call on logo clickthroughUrl)

**From TODOs:** `TODO-SHARED-button.md` cross-cutting + Priority 1, `TODO-SHARED-image.md` Priority 0, `TODO-SHARED-menu.md` cross-cutting, `TODO-SHARED-socials.md` cross-cutting.

**Estimated effort:** small — move code, add calls.

**Blockers:** Package A (the classifier emits warnings; cleaner if structured fields land first).

**Do together with A.**

---

## Work Package C — `types.ts` expansion pass

**Root cause:** Local type shims and missing fields accumulated because `src/renderer/types.ts` was frozen.

**Scope:** One comprehensive pass to align local types with prod Zod schemas.

**Type additions:**
- `EmailBlockType.PRODUCTS = "interactive-cart"` (currently a string shim in componentMap)
- `EmailBlockType.FOOTER` — NOT needed (decision reversed; footers stay as TextBlock)
- `Size` enum + `horizontalPadding` / `verticalPadding` on Image, Line (prod requires both)
- `showCaption: boolean` on Image (already being set, just upgrade to required)
- `imageSourceType?: ImageType` on Image (optional)
- `lineHeight?: string` + `textAlign?: string` on TextBlock (currently HTML-embedded workarounds)
- Lift `ProductsBlock`, `InlineButton`, `ProductImageSize`, `ProductLayoutType`, `ProductSelectionType`, `ManuallySelectedProduct`, `ProductFilterDoc` from `product.ts`
- Drop `ParsedLineBlock.thickness` + `innerPadding` extras (stuff `innerPadding` into existing `padding`, lose `thickness`)
- Remove `SocialIconColor.ORIGINAL` from enum (prod has black/white/gray only)

**Affects:**
- `src/renderer/types.ts` (all additions)
- `src/parser/blocks/product.ts` (delete local shims, import from types)
- `src/parser/blocks/line.ts` (drop `ParsedLineBlock` type, reshape `padding`/`innerPadding` usage)
- `src/parser/blocks/socials.ts` (drop ORIGINAL mapping path)
- `src/parser/blocks/text.ts` (drop HTML-embedding of lineHeight/textAlign, emit as structured fields)
- `src/parser/blocks/image.ts` (emit `horizontalPadding: Size.CUSTOM`, `verticalPadding: Size.CUSTOM`)
- `src/renderer/blocks/text.tsx` (read lineHeight/textAlign from props, not from embedded HTML)
- `src/renderer/blocks/line.tsx` (read padding/thickness structure from new shape)
- `src/renderer/index.tsx` (revert `Record<string, ...>` widening back to `Record<EmailBlockType, ...>`)

**From TODOs:** `TODO-SHARED-product.md`, `TODO-SHARED-line.md` Priority 0+1, `TODO-SHARED-image.md` Priority 1, `TODO-SHARED-socials.md` Priority 1+4, `TODO-SHARED-text.md` Priority 4.

**Estimated effort:** medium — multi-file but mechanical.

**Blockers:** none. Do after all parallel element work definitively wraps.

---

## Work Package D — Upstream parser + renderer fixes

**Root cause:** Two latent bugs affect multiple blocks. Both deferred because `src/parser/style-utils.ts` and individual renderers were shared files.

**D1. Fix `parsePadding` shorthand override bug**
`parsePadding` returns early when shorthand `padding` exists, ignoring individual `padding-top/right/bottom/left` overrides. `text.ts` worked around it with a local `parsePaddingWithOverrides`. Upstream the fix so every block benefits.

**Affects:** `src/parser/style-utils.ts`, then `src/parser/blocks/text.ts` (delete the local workaround).

**D2. Audit MjmlSection default padding across renderers**
MjmlSection defaults to `padding: 20px 0`. Spacer fixed this explicitly. Every other renderer likely inflates vertical spacing by 40px if it doesn't override.

**Affects:** `src/renderer/blocks/*.tsx` — walk each, ensure MjmlSection padding is set from `sectionPadding`.

**From TODOs:** `TODO-SHARED-text.md` Priority 3, `TODO-SHARED-spacer.md` Priority 2, `TODO-SHARED-line.md` cross-cutting.

**Estimated effort:** small (D1) + small (D2).

**Blockers:** none. Can do immediately.

---

## Work Package E — Migration pipeline: AI transforms + text substitution

**Root cause:** Several per-element issues are actually cross-block transformations that live in the export pipeline, not the parser. All need infrastructure (LLM, Redo API, merchant config).

**E1. Footer variable substitution** *(from `TODO-SHARED-text.md` PRIORITY 0)*
- `{% unsubscribe %}` → `<a href="{{ unsubscribe_link }}">unsubscribe</a>`
- `{{ organization.name }}` → merchant org name
- `{{ organization.full_address }}` → formatted merchant address
- Source org data from Klaviyo Accounts API (fallback to user prompt)

**E2. Inline coupon AI rewrite** *(from `TODO-SHARED-text.md` PRIORITY 1.C)*
- Klaviyo inline `{% coupon_code %}` mid-sentence → AI restructures to remove
- One LLM call per section (accuracy over cost, per feedback memory)

**E3. Discount object creation via Redo API** *(from `TODO-SHARED-text.md` PRIORITY 1.A + project memory)*
- User-provided prefix per migration (e.g. "QUIK")
- Inferred amount/type from surrounding text (already extracted by `extractCouponCodes`)
- Link `discountId` to each DiscountBlock

**E4. Font provisioning pipeline** *(from `TODO-SHARED-text.md` PRIORITY 2)*
- Walk all blocks collecting `fontFamily` fields (not just text)
- Resolve via Google Fonts API
- Upload to S3, register in Redo brand kit
- Render-time: Redo's `generateCustomFontCSSForFamily()` injects automatically

**E5. Image-as-button conversion** *(from `project_image_as_button_conversion` memory)*
- Klaviyo CTA images with `{{ event.URL }}` → Redo Button block
- Needs AI + flow context

**E6. Full-width button padding recovery** *(from `TODO-SHARED-button.md` PRIORITY 2)*
- Klaviyo zeroes horizontal padding on full-width buttons during MJML compile
- Apply sensible default OR leave as-is
- Low priority, revisit only if visual regression surfaces

**Affects:** new files in a `src/pipeline/` or similar directory; NOT per-element parsers.

**From TODOs:** `TODO-SHARED-text.md` Priority 0–2, `TODO-SHARED-button.md` Priority 2, `TODO-SHARED-discount.md`, multiple project memories.

**Estimated effort:** large — new infrastructure.

**Blockers:**
- Need LLM integration (Anthropic API)
- Need Redo API access + credentials (likely a discount-object creation endpoint)
- Need S3 access + Redo brand-kit API (font provisioning)
- Need Klaviyo Accounts API call (footer substitution)
- User must provide migration config: discount prefix per coupon name, org fallback if API fails

**Do as a dedicated Phase 2. Does not block import path testing.**

---

## Work Package F — Asset + CDN

**F1. Upload drop-shadow.png to CDN** *(from `TODO-SHARED-klaviyo-specific.md` Priority 0)*
- `pics/drop-shadow.png` currently referenced as local path; won't load in Redo
- Upload to the CDN/bucket Redo uses for stock imagery
- Replace `DROP_SHADOW_LOCAL_PATH` with CDN URL

**F2. (Optional) Rehost Klaviyo image URLs** *(from `TODO-SHARED-image.md` Priority 4)*
- Keep Klaviyo CDN URLs for MVP
- Revisit only if merchants report broken images after deleting Klaviyo accounts

**Affects:** upload + `src/parser/blocks/klaviyo-specific.ts` constant.

**Estimated effort:** small (F1) if CDN access is straightforward.

**Blockers:** need CDN write access.

---

## Work Package G — Import executor script

**Root cause:** No path to get generated JSON into Redo prod yet. See `reference_template_import_path` memory.

**Scope:** Build `~/code/redoapp/redo/manage/src/import-klaviyo-templates.ts` modeled on `copy-template-to-teams.ts`.

**Responsibilities:**
1. Read `.redo-template.json` files from `mime/migrations/<account>/templates/`
2. For each block with `_pendingFilter` (products block): POST to `https://app-server.getredo.com/marketing-rpc/createProductFilter`, swap response `productFilterId` into `recommendedProductFilterId`, delete `_pendingFilter`
3. Set `team` to target team ID
4. Pull `address` from Team doc (not hardcoded)
5. Regenerate `_id` with `new ObjectId().toString()`
6. Call `EmailTemplateRepo.createTemplate()`
7. Surface any warnings (REVIEW/UNSUPPORTED/SKIPPED) as importer output
8. Support `--readonly` flag per `redo/manage` conventions

**Affects:** new file in `redoapp` repo (not `mime`).

**From TODOs:** `TODO-SHARED-product.md` "Parser produces a `_pendingFilter`" section, `reference_template_import_path` memory.

**Estimated effort:** medium — modeled on existing script.

**Blockers:**
- Package A (warnings system) so the executor has structured data to report
- Redo creds for prod run

**Do after Package A. Enables first prod import test.**

---

## Work Package H — Polish / low-priority cleanup

Small items from across multiple TODOs. Batch into a single cleanup session:

- Rename `parseHeaderBlock` → `parseHeaderLogoAsImage` *(header TODO)*
- Delete dead `src/renderer/blocks/header.tsx` if not needed *(header TODO)*
- Consider deleting `stripStandaloneCoupons` in `text.ts` once coverage proven *(discount TODO)*
- Drop `ParsedLineBlock` type, move innerPadding into `padding` *(line TODO — covered in Package C)*
- Fix `@ts-expect-error TODO: noUncheckedIndexedAccess` in `column.tsx` and `text.tsx` renderers *(inline grep hits)*
- Extract parent-chain section-color walker into shared helper *(column TODO)*

**Estimated effort:** small.

**Blockers:** Package C for some items.

**Do after Package C.**

---

## Suggested ordering

### Phase 1 — Infrastructure cleanup (safe, immediate)
1. **Package D** — fix `parsePadding` bug + audit MjmlSection padding. No dependencies, high payoff.

### Phase 2 — Shared-file refactors (unfreeze)
2. **Package A** — warnings system (ParseResult structured fields).
3. **Package B** — URL classifier hoist into `url-mapping.ts`. Do together with A.
4. **Package C** — types.ts expansion. Do after A+B since those touch the same files.

### Phase 3 — Enable prod testing
5. **Package F1** — upload drop-shadow asset.
6. **Package G** — build import executor script.
7. **First prod import test** — import a handful of templates, eyeball them in the Redo builder.

### Phase 4 — Polish
8. **Package H** — cleanup items.

### Phase 5 — Migration pipeline (Phase 2 project)
9. **Package E** — AI transforms + text substitution + font provisioning + discount objects. Large, separate project. Don't start until prod import is proven.

### Not prioritized / skipped
- Package F2 (Klaviyo CDN rehost) — only if merchants complain
- Image aspect ratio + crop config — deferred per image TODO
- `itemSpacing` / `useCustomSpacing` on menu — deferred per menu TODO
- Line style (dashed/dotted) — accepted loss per memory

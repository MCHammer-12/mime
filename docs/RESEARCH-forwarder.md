# Research: Redo email forwarder pipeline

Captured 2026-04-11 from `redoapp/redo` clone at `~/code/redoapp/redo`.

## Purpose
This is the production pipeline that turns a forwarded marketing email (raw MIME) into a Redo `EmailTemplate` with a `sections: Section[]` body. The internal Klaviyo-HTML duplicator we're building reuses most of these pieces.

## End-to-end pipeline

### Stage 0 — HTTP entry
`redo/api/server/src/lambda/ses/forwarded-emails.ts:16`
- SES receives the email, SNS posts to this handler.
- `teamId` is parsed from the destination local-part (`teamId@forward.domain`).
- Starts Temporal workflow `processForwardedEmail` with `{ teamId, contentBuffer }` where `contentBuffer` is base64-encoded raw MIME.

### Stage 1 — Workflow orchestration
`redo/temporal/temporal/src/workflows/forwarded-emails/process-forwarded-email-workflow.ts:14`

Runs 4 activities sequentially, with cleanup on failure:
1. `createEmptyTemplate` — inserts a placeholder `SavedEmailTemplate` with empty `sections`
2. `analyzeForwardedEmail` — Stage 2 (see below)
3. `generateTemplateContent` — Stage 3 (see below)
4. `saveGeneratedTemplate` — writes `sections` + generated name back to the placeholder

Activity definitions live in `redo/temporal/temporal/src/activities/forwarded-emails/process-forwarded-email-activity.ts`.

### Stage 2 — MIME → prose block description
`redo/server/src/marketing/create-analyzed-marketing-email-file.ts`

1. `simpleParser` (mailparser) extracts HTML from `message/rfc822`.
2. `deepAiFileAnalysis` → vision-capable OpenAI call with `SYSTEM_PROMPT` (lines 73–179).
3. Output: a free-form `analysis` string + the HTML uploaded to S3. Record stored in `AiAnalyzedFile` collection.

The system prompt is the heart of the system. Key rules:
- Output is a numbered list of blocks: `COLUMN`, `TEXT`, `BUTTON`, `IMAGE`, `SPACER`, `LINE`, `MENU`, `SOCIALS`, `DISCOUNT`.
- Side-by-side layouts MUST be described as `COLUMN` with nested content.
- No nested `COLUMN` blocks.
- Discount codes NEVER inside `TEXT` blocks — always a dedicated `DISCOUNT` block.
- Image URLs must be preserved verbatim.
- 2x2 grids get split into multiple `COLUMN` rows, not nested cards.
- Strip forwarded/reply headers; keep only the original email content.

### Stage 3 — Prose description → Redo `Section[]`
`redo/server/src/marketing/generate-email-template.ts:74`

Three sub-steps:

**3.1 `generateRoughSections` (`:161`)**
- Model: `GPT_4_1_20250414`, temperature 0
- System prompt built from `sectionDescriptions` (per-block human-readable schema)
- User prompt includes the original HTML via `getHtmlUploadedFilePrompt` + the prose description
- `responseFormat: json_object` — returns `{ sections: [...] }` as free-form JSON

**3.2 `processSectionsStructure` (`:527`)**
- Second pass, per section, in parallel
- Each rough section is re-fed to GPT-4.1 with a Zod-derived JSON schema (`responseFormat: json_schema, strict: true`)
- Coerces into the exact Zod shape
- `COLUMN` sections recurse on their inner `columns`; nesting COLUMNs throws
- **Silent failure**: sections that fail coercion return `null` and are filtered out (`:604–613`). No telemetry on drop rate.

**3.3 `addBlockIds` (`:666`)**
- Stamps a fresh `new ObjectId()` on each section as `blockId`.

## Schema — the target `Section[]` format

Canonical source of truth: `redo/model/src/email-template.ts` (905 lines)

- `Section` is re-exported as an alias for `EmailBlock` in `redo/model/src/email-builder.ts:20`
- `EmailBlockType` enum: `redo/model/src/email-builder.ts:219` — ~25 block types total
- **Only 11 AI-supported types** (`redo/marketing/common/src/ai-email-template-types.ts:67`):
  `BUTTON, HEADER, IMAGE, TEXT, SPACER, LINE, COLUMN, MENU, SOCIALS, DISCOUNT, SHOPPABLE_PRODUCTS`
- Every block extends `baseSectionSchema` (`email-template.ts:62`):
  `{ blockId, sectionPadding: {top,right,bottom,left}, sectionColor }`
- `COLUMN` is the only recursive type. Nesting is rejected at runtime.
- Full template wrapper: `emailTemplateSchema` at `email-template.ts:752`
  `{ _id, name, subject, templateType, category, schemaType, emailBackgroundColor, contentBackgroundColor, address, sections, ... }`

AI-facing schema variants (`ai-email-template-types.ts`): strip `blockId`, mark `sectionPadding` required.

Block types NOT emitted by the forwarder (transactional/interactive):
`TRACKING_INFO, PRODUCTS, REVIEW_REQUEST, QR_CODE, CHROME_DINO, FOOTER, SCRATCH_TO_REVEAL, INTERACTIVE_REVIEW_REQUEST, ONE_CLICK_SUBSCRIPTION, SECTION_REFERENCE, SUBSCRIPTION_*`

## Reusable entrypoints for the duplicator tool

All three live in `redo/server/src/marketing/` and are pure functions — no HTTP or Temporal dependency:

1. `createAnalyzedMarketingEmailFile({ teamId, buffer, mimetype, originalname, source })`
   - Pass Klaviyo HTML as a Buffer with `mimetype: "text/html"` to skip the EML parse
   - Runs the stage-2 analyzer LLM, uploads to S3, returns `{ _id, analysis, url, ... }`

2. `generateEmailTemplate({ description, images, teamId, reference: { htmlUploadedId }, keepExistingStyles: true })`
   - Runs all of stage 3, returns `Section[]`

3. `SavedEmailTemplateRepo.saveTemplate(...)`
   - Persists to the `SavedEmailTemplate` collection the same way the forwarder does

Internal tool = thin wrapper: take `{ teamId, html }`, call these three, done.

## Weaknesses (eval-harness targets)

1. **Lossy two-call pipeline.** HTML → prose → JSON. Even though stage 3 re-injects the HTML, the rough-sections LLM is primed by a lossy prose summary. Exact paddings, column widths, font stacks are prone to drift.
2. **Silent section drops.** `processSectionsStructure` catches errors and filters `null` without logging counts. No visibility into how often sections disappear.
3. **Image URLs are described, not extracted.** The system prompt asks the LLM not to modify URLs — but cheerio could do this deterministically with zero hallucination risk.
4. **No eval harness in the tree.** Only `logger.info` counts. The 388-template Klaviyo corpus is perfect for building one.
5. **`keepExistingStyles` contamination risk.** The path fetches the merchant's last 2 finished campaigns and stuffs their `Section[]` verbatim into the prompt. Helpful for brand consistency, potentially contaminating for one-off sends. Worth A/B testing.

## Related code paths worth knowing

- `callLLM` wrapper: `@redotech/openai-deprecated/ai/call-llm` — handles API key, product tagging, timing
- `deepAiFileAnalysis` + `getFileSource`: `@redotech/openai-deprecated/ai/file-analysis` — converts HTML to images for vision calls
- `AiAnalyzedFileRepo`, `SavedEmailTemplateRepo`, `EmailTemplateRepo`, `CampaignRepo`: all under `@redotech/redo-marketing-db-util`

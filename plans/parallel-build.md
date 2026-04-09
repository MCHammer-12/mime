# Mime Parallel Build Plan

Goal: split v1 into independent agent-sized tasks that can run in parallel. Each task has a clear contract (inputs, outputs, test) so it can be built and verified without touching other tasks.

## Ground rules for all agents

- **Language:** TypeScript, Node ESM (`"type": "module"`, `.js` imports in TS).
- **Working dir:** `/Users/michael.hammer/code/redo/mime`
- **Run:** `npx tsx src/<file>.ts`
- **Klaviyo key:** read from `KLAVIYO_API_KEY` env var. Do not hardcode.
- **Shared client:** `src/klaviyo.ts` exports `klaviyo(path, key)`, `paginate(path, key)`, `slug(name, fallback)`. Reuse, don't duplicate.
- **Output layout:** everything lives under `migrations/<merchant>/...`. Never write outside.
- **No destructive ops:** extractors only read. Never hit POST/PUT/DELETE on Klaviyo.
- **When done:** print a short summary line and exit 0. Fail loudly on errors.
- **Test = run it end-to-end against `MERCHANT=test-account` with the real key** and verify the output files exist and the structure is correct. Don't mock.

## Parallel tasks

### Task A — Campaigns extractor
**Build:** `src/extract-campaigns.ts`. List all campaigns via `/campaigns/?filter=equals(messages.channel,'email')` (required filter), fetch each campaign's messages, resolve the template per message. Write per-campaign JSON to `migrations/<merchant>/campaigns/<id>-<slug>.json`. Write `migrations/<merchant>/campaigns-manifest.json` with id, name, status, send_time, message_count, template_ids.

**Inputs:** `KLAVIYO_API_KEY`, `MERCHANT` env vars.

**Outputs:** per-campaign JSON bundle `{ campaign, messages, templates: { [msgId]: templateSummary } }`; manifest.

**Test:**
1. `KLAVIYO_API_KEY=pk_... MERCHANT=test-account npx tsx src/extract-campaigns.ts`
2. Expect non-zero count of campaigns printed.
3. `cat migrations/test-account/campaigns-manifest.json | jq '.campaigns | length'` > 0.
4. Pick one campaign file and verify it has `campaign.attributes.name` and at least one message entry.
5. Verify at least one message references a template id that exists in `templates-manifest.json` (cross-reference).

**Docs:** https://developers.klaviyo.com/en/reference/campaigns_api_overview

---

### Task B — Image downloader
**Build:** `src/extract-images.ts`. Walk every template HTML under `migrations/<merchant>/templates/`, extract every `<img src="...">` URL (also `background-image: url(...)` in inline styles), dedupe, download each to `migrations/<merchant>/images/<hash>-<filename>`, and write `migrations/<merchant>/images-manifest.json` mapping original URL → local path and listing which templates reference which images.

Use content-hash (sha256 first 12 chars) to dedupe. Skip data URIs. Respect 10 concurrent max.

**Inputs:** existing `migrations/<merchant>/templates/*.html` (from templates extractor).

**Outputs:** `migrations/<merchant>/images/` populated, `images-manifest.json`.

**Test:**
1. Ensure templates extractor has been run first.
2. `MERCHANT=test-account npx tsx src/extract-images.ts`
3. `ls migrations/test-account/images/ | wc -l` should be > 50 (there are 388 templates).
4. Open 3 random image files — they should be valid image files (use `file` command).
5. `cat migrations/test-account/images-manifest.json | jq '.images | length'` > 0.
6. Verify one manifest entry has a `referenced_by` array with template ids that exist in `templates-manifest.json`.

---

### Task C — Redo block schema discovery
**Build:** `docs/redo-block-schema.md`. This is RESEARCH, not code. The agent should: (1) ask the user for access to Redo's admin UI or internal API docs, (2) inspect the JSON shape of a drag-drop email template in Redo (via network tab, internal API, or the user walking them through it), (3) document every block type (text, heading, image, button, divider, columns, spacer, video, product, etc.) with its JSON schema and an example payload.

**Inputs:** user access to Redo.

**Outputs:** a markdown doc in `docs/redo-block-schema.md` listing each block type with schema and example.

**Test:**
1. Doc exists.
2. Covers at least: text, heading, image, button, divider, spacer, columns.
3. Each block type has a real example JSON payload copied from Redo (not made up).
4. The user confirms it matches what they see in Redo.

**Note:** this task is blocking for the translator and executor. Prioritize it.

---

### Task D — Translator POC (LLM: HTML → block plan)
**Build:** `src/translate.ts`. Reads one Klaviyo template HTML file + the Redo block schema (from Task C). Calls Claude via `@anthropic-ai/sdk` with a prompt that includes the schema and asks for a structured block plan. Outputs `migrations/<merchant>/block-plans/<templateId>.json`.

Prompt should: include the Redo schema verbatim, include the stripped HTML (strip `<style>`, comments, tracking pixels), ask for JSON matching the schema, use tool_use / structured output to force JSON.

CLI: `npx tsx src/translate.ts --template <id> [--merchant test-account]`

**Inputs:** `ANTHROPIC_API_KEY`, template HTML, `docs/redo-block-schema.md`.

**Outputs:** `migrations/<merchant>/block-plans/<templateId>.json`.

**Dependencies:** Task C must be done first (needs schema).

**Test:**
1. Pick 3 templates of varying complexity: `Lgdf7J` (Newsletter #1, simple), `H76ZS6` (Newsletter #4, moderate), `YaieyN` (Welcome, 53KB, complex).
2. Run translator on each.
3. Output JSON validates against the Redo schema (write a quick validator or eyeball).
4. User spot-checks one block plan against the original HTML rendered — does it capture the key content (text, headings, buttons, images)?
5. Report token cost per translation.

---

### Task E — Preview renderer for block plans
**Build:** `src/preview-block-plan.ts`. Takes a block plan JSON and renders a rough HTML preview so the user can eyeball it before execution. Does NOT need to match Redo's styling exactly — just show the structure (block type, content, image, link).

CLI: `npx tsx src/preview-block-plan.ts <plan.json>` writes `<plan>.preview.html` and prints its path.

**Inputs:** a block plan JSON file.

**Outputs:** an HTML file showing each block with its type label and content.

**Dependencies:** Task C (to know block types).

**Test:**
1. Run on a sample block plan (real or hand-written).
2. Open the output HTML in a browser.
3. Verify every block in the JSON is visible, labeled with its type, with content shown.

---

### Task F — Redo executor skeleton (Playwright)
**Build:** `src/execute/login.ts`. Launches Playwright headed, navigates to Redo admin, waits for user to log in manually (first run), saves the auth state to `.auth/redo.json`. Subsequent runs reuse the saved state. Then navigates to the email template editor and opens a blank new template.

Nothing else — no block building yet. Just prove we can get into the editor reliably.

**Inputs:** Redo admin URL (ask user), optional saved auth state.

**Outputs:** `.auth/redo.json`, and a final screenshot `migrations/debug/executor-login.png` showing the blank editor.

**Dependencies:** user provides Redo URL + credentials (they log in manually).

**Test:**
1. First run: `npx tsx src/execute/login.ts --url <redo-admin-url>` — user logs in, script waits, saves state.
2. Second run: reuses state, opens editor without user interaction, saves screenshot.
3. User verifies the screenshot shows the blank template editor.

**Note:** do not automate login form-filling. User types credentials themselves (permissions rule).

---

### Task G — Flows + Campaigns schema normalizer
**Build:** `src/normalize.ts`. Reads the raw flows and campaigns JSON and produces a `migrations/<merchant>/normalized.json` summary: a flat structured list of every email that needs to be migrated, with source (flow vs campaign), name, trigger/schedule, template id (pointing to the block plan file), and position in sequence.

This is the input the executor will loop over.

**Inputs:** existing flows/, campaigns/, templates-manifest.json.

**Outputs:** `migrations/<merchant>/normalized.json` shaped like:
```json
{
  "emails": [
    { "source": "flow", "source_id": "HKxNAS", "source_name": "Browse Abandonment",
      "position": 1, "template_id": "...", "name": "...", "trigger": "..." },
    { "source": "campaign", "source_id": "...", "source_name": "...", "send_time": "...",
      "template_id": "...", "name": "..." }
  ]
}
```

**Dependencies:** Tasks A (campaigns extractor) must be done. Flows already done.

**Important finding from Task A (2026-04-08):** Campaign-scoped email templates are clones that do NOT appear in the main `/templates/` listing endpoint. The templates extractor will NOT have them. Their HTML + attributes are embedded inline in each campaign bundle under `.templates[msgId]`. For campaigns, resolve the template from the campaign bundle directly; do not try to cross-reference `templates-manifest.json` for campaign templates. For flows, the template lookup via `templates-manifest.json` works fine.

**Test:**
1. Run after A completes.
2. `jq '.emails | length' normalized.json` > 0.
3. Every entry has a `template_id` that exists in `templates-manifest.json`.
4. Pick a flow in Klaviyo's UI and verify the normalized output matches (same number of sends, same order).

---

### Task H — End-to-end dry run harness
**Build:** `src/dry-run.ts`. Takes a merchant, walks the normalized list, for each email: confirms extracted HTML exists, confirms block plan exists (if Task D has run), prints a status report. Does NOT touch Redo. Pure read + report.

**Inputs:** `MERCHANT` env var.

**Outputs:** stdout report with counts (total, extracted, translated, missing).

**Dependencies:** Task G.

**Test:**
1. Run after G.
2. Report shows sensible counts and lists any missing items.
3. User reads the report and confirms numbers match their mental model.

---

## Dependency graph

```
templates-extractor (done)
  ├── B: images
  ├── D: translator (also needs C)
  └── G: normalizer (also needs A)
flows-extractor (done)
  └── G: normalizer
A: campaigns extractor
  └── G: normalizer
C: Redo schema research (blocking, not parallelizable)
  ├── D: translator
  ├── E: preview renderer
  └── F: executor skeleton (indirectly, eventual)
G: normalizer
  └── H: dry-run harness
```

## Suggested parallelization

**Wave 1 (can all run concurrently, no dependencies on each other):**
- Task A (campaigns)
- Task B (images)
- Task C (Redo schema — user-assisted)
- Task F (executor login skeleton — user-assisted)

**Wave 2 (after wave 1):**
- Task D (translator — needs C)
- Task E (preview renderer — needs C)
- Task G (normalizer — needs A)

**Wave 3:**
- Task H (dry run — needs G)

## How to launch

Each task should be given to a separate `general-purpose` agent with:
1. A link to this plan doc
2. Its task letter and the full task section
3. The Klaviyo key (if needed): `pk_bc1eef6ccda7e107b42814f28fc4277780`
4. A reminder to READ existing code in `src/klaviyo.ts` and `src/extract-templates.ts` before writing anything (to match style)
5. A reminder that the test is not optional — they must run it against the real account

## Definition of done per task
- Code in place, follows existing conventions
- Test steps run cleanly
- Output files exist and have expected structure
- Summary printed at end of script
- No hardcoded secrets

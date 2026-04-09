# Mime v1 — Klaviyo → Redo Email Migration (Human-in-the-Loop)

Status: Draft
Date: 2026-04-08

## Goal
Cut the time Michael spends rebuilding a Klaviyo merchant's emails, flows, and campaigns inside Redo's Marketing Cloud by 70%+. Not full autonomy. Michael reviews every output before it goes live.

## Scope for v1
- One merchant at a time
- Email templates (body content) — the painful part
- Flow structure (triggers, delays, branches) — metadata only
- Campaigns — metadata only
- Images — downloaded and re-uploaded
- Out of scope: SMS, A/B variants, segmentation rules, deliverability settings

## Architecture

Three layers. Deterministic where possible, LLM where necessary.

### 1. Extractor (deterministic, Python or Node)
Pulls everything from Klaviyo via API into a local working directory.

```
migrations/<merchant>/
  flows.json          # flow definitions (trigger, action tree)
  campaigns.json      # campaign metadata
  templates/
    <template_id>.json    # raw Klaviyo template JSON
    <template_id>.html    # exported HTML fallback
  images/             # downloaded from CDN URLs referenced in templates
  manifest.json       # index + status per item
```

Inputs: Klaviyo private API key for the merchant account.

### 2. Translator (LLM-assisted)
For each Klaviyo template, produces a structured "block plan" — an ordered list of operations describing what to build in Redo's editor.

**Confirmed 2026-04-08:** Klaviyo's public templates API does NOT expose the drag-drop block JSON. It returns `editor_type: SYSTEM_DRAGGABLE` and the flattened `html` only. Translation is HTML-only. No block-to-block mapping shortcut.

Input: Klaviyo template HTML + image paths
Output: `block_plan.json` like:
```json
[
  {"type": "image", "src": "images/hero.png", "alt": "...", "link": "..."},
  {"type": "heading", "level": 1, "text": "...", "align": "center"},
  {"type": "button", "text": "Shop Now", "href": "...", "style": "primary"},
  ...
]
```

Why LLM here: Klaviyo's drag-drop blocks don't map 1:1 to Redo blocks. Parsing raw HTML into semantic blocks ("this table is a button") is exactly what LLMs are good at. Deterministic parsers fail on custom layouts.

Verification: rendered preview of the block plan shown to Michael before Redo execution.

### 3. Executor (hybrid: scripted + agent)
Drives Redo's admin UI via Playwright / browser-use.

**Deterministic parts:**
- Login
- Navigate to "new email template"
- Save, name, publish
- Known selectors for top-level editor actions

**Agentic parts:**
- For each block in the plan, reason about how to add it in the current editor state
- Handle drag-drop, rich-text formatting, image upload modals
- Retry on per-step visual mismatch

**Human-in-the-loop checkpoints:**
1. After extraction — Michael sees the manifest, approves what to migrate
2. After translation — Michael reviews each block plan (web UI or terminal), can edit before execution
3. After execution — side-by-side screenshot diff of Klaviyo vs Redo, Michael approves or flags
4. Never auto-publishes — leaves as draft in Redo

## Tech stack (proposed)
- **Language:** TypeScript (Node) — browser automation is more mature there
- **Extractor:** plain `fetch` against Klaviyo API
- **Translator:** Claude Sonnet via Anthropic SDK, structured output
- **Executor:** Playwright for deterministic parts, Anthropic computer-use or browser-use for agentic parts
- **Review UI:** simple local web app (Vite + React) or just CLI + browser previews
- **Storage:** local filesystem per merchant, no DB for v1

## Open questions
1. ~~Does Klaviyo's template API return structured drag-drop JSON, or only flattened HTML?~~ **Answered 2026-04-08: HTML only.**
2. Does Redo's admin UI have stable selectors, or is it a heavily dynamic React app with generated class names? (Affects executor reliability.)
3. Image re-hosting: does Redo need them uploaded through its own asset manager, or does it accept external URLs?
4. Volume: how many merchants per week? (Determines whether this investment pays off vs. just faster manual work.)
5. Auth: does Michael log into Redo as himself or impersonate the merchant?

## Milestones
1. **Extractor working end-to-end** on one real merchant's Klaviyo account. Output: on-disk manifest. (1-2 days)
2. **Translator prototype** — convert 3-5 real templates to block plans, Michael grades accuracy. (2-3 days)
3. **Executor deterministic skeleton** — login + create-empty-template + save in Redo, no content yet. (1-2 days)
4. **Executor block-building loop** — add one block type at a time, starting with text and images. (3-5 days)
5. **Review UI** — show block plan + screenshot diff before/after. (2 days)
6. **Run on 1 real migration end-to-end**, measure time saved, iterate.

## Non-goals for v1
- No scheduling / queuing
- No multi-user
- No Redo API integration (explicitly assumed unavailable)
- No SMS
- No cost optimization — we'll burn tokens in v1 to prove it works

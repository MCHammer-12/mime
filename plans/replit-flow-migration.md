# Replit Flow Migration Plan

**Goal:** ship a self-serve Replit app where a merchant can: (1) connect Klaviyo, (2) see every flow + standalone email template, (3) select which ones to bring across, (4) submit — flows arrive in Redo with their real email content intact, not blank placeholders.

**Status:** V1 parser + placeholder importer working end-to-end (verified on 4 real flows across otishi + AJ). This plan converts that scaffolding into the productized vision.

---

## What we have today

- `src/flow/*.ts` — Klaviyo flow → Redo AdvancedFlow JSON (emits `__PLACEHOLDER_<id>__` sentinels for emails)
- `src/parser/*.ts` — Klaviyo HTML → Redo EmailTemplate sections (mature: 416 templates, 0 failures)
- `src/extract-*.ts` — Klaviyo API extractors (flows, templates, metrics, campaigns, images)
- `redoapp/redo/manage/src/import-klaviyo-flows.ts` — reads parser output, creates blank templates + automation (direct Mongo)
- `redoapp/redo/manage/src/import-klaviyo-templates.ts` — existing template importer (direct Mongo)

## What's missing

1. **Flow imports use blank placeholders** — the two parsers aren't wired together
2. **No HTTP surface on redoapp** — Replit can't push data without someone running bazel
3. **No Replit app** — selection UI, job queue, mid-job prompts

---

## Phase A — Combine parsers: real emails inside flows

The highest-value work and has **zero** redoapp dependencies. Gets merchants a fully-populated flow from the existing bazel script.

### A.1 — Extend flow parser to resolve templates

**File:** `src/flow/steps/send-email.ts` (new — split out of parser.ts)

When we hit a `send-email` action, resolve the referenced Klaviyo template:

```ts
async function resolveTemplate(
  klaviyoTemplateId: string,
  ctx: ParseContext,
): Promise<{ sections: EmailTemplateSection[]; meta: TemplateMeta } | null> {
  // 1. Read migrations/<merchant>/templates/<id>.json (already extracted)
  // 2. Extract HTML from template.attributes.html
  // 3. Run existing parser: parseTemplate(html) → Section[]
  // 4. Run transform.ts for variable substitution
  // 5. Return full template shape OR null on failure
}
```

**Fallback:** if template file missing OR parser throws, emit a blank placeholder with a `requires-review` warning. We never block an import on a single bad template.

**Extraction prereq:** flow imports now require `extract-templates.ts` to have run first. Add a check + clear error message.

### A.2 — Flow parser emits full template data

Change `PlaceholderTemplate` interface in `src/flow/types.ts`:

```ts
interface PlaceholderTemplate {
  sentinelId: string;
  klaviyoTemplateId: string | null;
  // Metadata always present (from the send-email action itself)
  subject: string;
  fromEmail: string | null;
  fromLabel: string | null;
  previewText: string | null;
  // Full template data if parse succeeded; null falls back to blank
  fullTemplate: {
    sections: unknown[];
    _pendingFilter?: unknown;
    _fontPlan?: unknown;
    emailBackgroundColor: string;
    contentBackgroundColor: string;
  } | null;
}
```

### A.3 — Update importer to use real data

**File:** `redoapp/redo/manage/src/import-klaviyo-flows.ts`

In `createPlaceholderTemplate`, if `fullTemplate` is present:
1. Handle `_pendingFilter` → create ProductFilter, swap in ID (reuse logic from `import-klaviyo-templates.ts`)
2. Handle `_fontPlan` → sync brand kit fonts (reuse `syncFontPlansToBrandKit`)
3. Pass full `sections` array to `EmailTemplateRepo.createTemplate`

The two importers share a lot of logic. Extract the shared pieces to `import-klaviyo-shared.ts`:
- `iteratePendingFilterBlocks`
- `syncFontPlansToBrandKit`
- Team-address builder
- ProductFilter upsert

### A.4 — Smoke test

Import VeffyL again. All 7 emails should now have their original Alexander Jane content instead of blank templates.

**Effort:** 1 day. No new surface area, just wiring.

---

## Phase B — Redoapp PR: Replit push endpoint

One PR lands everything Replit needs to self-serve imports.

### B.1 — Research existing RPC surface

Before designing new endpoints, confirm what's already exposed:

- `redo/merchant/sdk/src/rpc/schema/advanced-flows/create-advanced-flow.ts` exists. Is it user-permissioned only, or admin-callable?
- Is there an equivalent for `EmailTemplate` creation? Grep for `createEmailTemplate` in `rpc/schema/`
- Is there a `createProductFilter` RPC (we've seen references in memory)?
- Is there an RPC for brand-kit font uploads? (per `reference_brand_kit_font_upload` memory)

If all four exist and are callable with a team-admin token, Phase B becomes "wire Replit to call them in the right order." If some are missing, we add them.

### B.2 — Design decision: bulk vs. chatty

**Option 1 — Chatty (reuse existing per-resource RPCs):**
- Replit calls `createEmailTemplate` N times, then `createProductFilter` M times, then `createAdvancedFlow` once per automation
- Pros: zero new endpoints. Just plumbing from Replit side.
- Cons: N+M+1 round trips per automation. For a big merchant (40 flows × 5 emails), 200+ calls. Slow, harder to roll back.

**Option 2 — Bulk endpoint (`POST /marketing-rpc/importKlaviyoFlows`):**
- Single request carries: `automations[]`, `templates[]`, `productFilters[]`, `fontPlan`
- Server orchestrates creation order, rolls back on failure, returns created IDs
- Pros: atomic, fast, clean error semantics
- Cons: new handler + schema + tests (~1 day work)

**Recommendation:** start chatty (0 backend work, ship today), move to bulk only if latency becomes a real problem.

### B.3 — Authentication

How does Replit prove it's acting for a specific team? Three options:

- **Redo admin PAT per merchant** (simplest): team owner generates a token in Redo settings, pastes into Replit. Token is admin-scoped. Fine for internal use / small rollout.
- **Merchant OAuth flow** (productized): Replit is an OAuth app. User clicks "connect Redo," redirects, grants team-scope, Replit stores refresh token.
- **Existing Redo merchant-app session cookie** (only works if Replit is on the same domain): not viable.

**Recommendation:** ship with PAT for v1, plan OAuth for v2.

### B.4 — What the PR contains

Single PR to redoapp with:

1. **If Option 1 (chatty):** just auth changes — ensure `createAdvancedFlow` + `createEmailTemplate` RPCs accept admin-PAT-authenticated calls. Add tests.
2. **If Option 2 (bulk):**
   - New handler `redo/marketing/server/src/handler/import-klaviyo/bulk-import-klaviyo-flows.ts`
   - Zod request schema
   - RPC registration in `redo/merchant/sdk/src/rpc/definition.ts`
   - Transaction boundary: create templates → product filters → automations in a single Mongoose session. Rollback on any failure.
   - Integration test: POST a real bundle, assert the docs landed + all IDs resolve
3. **Commit the ops-run script too:** `redo/manage/src/import-klaviyo-flows.ts` — currently uncommitted. Keep it as the fallback path for Redo ops.
4. **Add to `redo/manage/AGENTS.md`** and a brief README entry.
5. **Dedup field:** add `klaviyoSourceId: string` to AdvancedFlow + EmailTemplate schemas. Any import checks for an existing doc with the same `klaviyoSourceId` + `team` before creating. This matters for re-runs after partial failures.

**Effort:** chatty path = 1–2 days (mostly auth + tests). Bulk path = +2 days.

---

## Phase C — Replit app (UI + job engine)

The merchant-facing surface. Out of this plan's critical path but the vision target.

### C.1 — Surface areas

- **Klaviyo connect** — API key input form. Optional: Klaviyo OAuth if we want merchant-self-serve.
- **Redo connect** — paste PAT (per B.3).
- **Discovery view:**
  - Tab 1: Flows list. Columns: name, trigger, enabled, step count, email count.
  - Tab 2: Standalone templates (templates not referenced by any flow).
  - Select-all, filter, search.
- **Submit button** → creates a Job.
- **Job dashboard** — one row per job. Columns: status, progress, created, merchant, Redo team.
- **Job detail page** — per-step log, each automation's Redo flow ID (linking out to Redo UI), each template's ID, warnings surfaced per step.
- **Mid-job input prompts** — inline card on the job page when the job is paused waiting on user input.

### C.2 — Job engine

Single-process worker is fine for v1. Postgres or SQLite for job state. BullMQ if we need background workers later.

**Job state machine:**

```
queued → extracting → parsing → awaiting-input (optional) → importing → done | failed
```

Each state transition writes a log row (visible in the UI). The `awaiting-input` state blocks until the user responds via `POST /jobs/:id/inputs`.

**Touchpoints that pause the job** (from `project_migration_human_input_ux` memory):
- Discount code prefix (default "RE", allow override)
- Discount amount/type (if Klaviyo coupon ambiguous)
- Organization name (if Klaviyo Accounts API returns null)
- Image-as-button detection (prompt: strip or keep as image?)
- Unresolved URL variables (interactive M/U/S prompts)
- Static product resolution (if Shopify lookup fails)
- Transactional email flag (if Klaviyo `transactional: true` is set)
- Font preflight block (if a font upload fails)

Each of these emits a **promptable event** during the parse phase; the job writes a row to `pending_inputs`, the UI polls it, merchant responds, parse resumes.

### C.3 — Concurrency

Each job runs in its own working directory. Parse phase is CPU-bound (fine at small scale). Import phase is I/O-bound (HTTP calls to redoapp). 4–8 concurrent jobs is plenty for early rollout.

**Effort:** 2–3 weeks. Bigger piece, separate planning pass when we get there.

---

## Phase D — Production readiness

After Phases A–C are working in happy-path:

1. **Dedup:** Use `klaviyoSourceId` field (see B.4) so re-runs are idempotent.
2. **Rollback:** `delete-klaviyo-flows.ts` sibling script that takes a `klaviyoSourceId` list and removes the created docs.
3. **Partial-import resume:** if parse succeeds but import fails halfway, the `klaviyoSourceId` index lets us skip already-created docs on retry.
4. **Observability:** per-job structured logs → Datadog or similar. Error aggregation by merchant + flow.
5. **Audit trail:** Redo admin sees who imported what, when. `createdByUserId` already supported — just wire the Replit user's Redo identity in.
6. **Quota / rate limiting:** Replit-side cap on concurrent jobs per team to avoid DB spikes.

**Effort:** 1 week, can be incremental.

---

## Open decisions before we start

1. **Chatty vs. bulk endpoint** (Phase B.2) — want to go chatty first?
2. **Auth model** (Phase B.3) — PAT v1 OK, or OAuth straight away?
3. **`klaviyoSourceId` scope** — on every imported doc (automation + template + filter + font)? Or just the automation?
4. **Phase A failure mode** — if template parsing fails, fall back to blank placeholder silently, or surface a job-level prompt?
5. **How does Replit get the Klaviyo API key** — merchant pastes it? OAuth? We already have the extraction infra either way.

---

## Proposed ordering

| Order | Phase | Blocks | Effort |
|-------|-------|--------|--------|
| 1 | **Phase A** (combine parsers) | nothing — ships immediate user value via bazel script | 1 day |
| 2 | **Phase B** (redoapp PR, chatty + PAT) | unblocks Replit push | 1–2 days |
| 3 | **Phase C.1–C.2** (Replit app MVP) | needs Phase B | 2 weeks |
| 4 | **Phase C.3 + Phase D** (polish) | optional, iterate | ongoing |

**What's shippable end of week 1:** bazel-run imports produce flows with real email content intact (Phase A done).
**What's shippable end of week 2:** Replit can push directly to redoapp (Phase B done). Bazel script becomes the ops-fallback.
**What's shippable end of week 5:** merchant-facing Replit app (Phase C done).

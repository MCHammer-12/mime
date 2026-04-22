# Replit Migration UI — API Contract

Paste this into Claude design to spec out the frontend. The backend endpoints are already wired in `src/migrate/server.ts` and this doc describes their shapes.

---

## Server base

The backend runs at `http://localhost:8765` (or whatever `PORT` env var). All endpoints require HTTP Basic auth when `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` env vars are set (otherwise no auth).

---

## 1. `GET /api/env`

**Response:**
```json
{
  "hostedDeploy": false,  // true on Replit — affects whether bazel path is available
  "aiAvailable": false    // true when server has Anthropic key; UI can hide the key input
}
```

---

## 2. `POST /api/templates` — list standalone templates

**Request:**
```json
{ "klaviyoKey": "pk_..." }
```

**Response:**
```json
{
  "templates": [
    {
      "id": "H76ZS6",
      "name": "Newsletter #4 — Story Boxes",
      "editorType": "SYSTEM_DRAGGABLE",   // or "CODE"
      "updated": "2024-10-15T12:34:56Z"
    }
  ]
}
```

Usage in UI: render a selectable list, filterable by name. User picks N templates to import as standalone Redo email templates.

---

## 3. `POST /api/flows` — list flows + their emails

**Request:**
```json
{ "klaviyoKey": "pk_..." }
```

**Response:**
```json
{
  "flows": [
    {
      "flowId": "VeffyL",
      "flowName": "Shopify | Welcome Flow Email",
      "flowStatus": "live",            // "live" | "draft" | "manual" | "disabled"
      "triggerType": "Added to List",
      "emails": [
        {
          "templateId": "WpE6sC",      // null if the flow-message has no template
          "messageId": "74706321",
          "actionId": "84880779",
          "name": "Welcome email"
        }
      ]
    }
  ],
  "debug": { /* diagnostic counts for troubleshooting empty results */ }
}
```

Usage in UI:
- Render each flow as a row: name, status badge, email count, trigger type
- User can select flows as **whole-flow imports** (imported as Redo Automations with all emails intact)
- Optionally expand a row to preview the emails inside (read-only preview, or individual-email selection if you want to support both modes)

---

## 4. `POST /api/jobs` — create an async import job

**Request** (same shape as `/api/run` with one addition):
```json
{
  "klaviyoKey": "pk_...",
  "storeId": "69dff28302f64f42e6012a4d",
  "storeName": "Alexander Jane",       // NEW — user-friendly display name
  "merchantSlug": "alexanderjane",
  "templateIds": ["H76ZS6"],
  "flowIds": ["VeffyL"],
  "redoJwt": "eyJ...",
  "redoServerBase": "https://app-server.getredo.com",
  "skipAi": true,
  "runImport": true
}
```

**Response (202 Accepted):**
```json
{ "jobId": "550e8400-e29b-41d4-a716-446655440000", "status": "queued" }
```

The job kicks off in the background immediately. Client streams events via `GET /api/jobs/:id/stream` and (optionally) answers prompts via `POST /api/jobs/:id/inputs`.

## 5. `GET /api/jobs` — list jobs (multi-store dashboard)

Optional `?storeId=<id>` filter.

**Response:**
```json
{
  "jobs": [
    {
      "id": "uuid",
      "storeId": "...",
      "storeName": "Alexander Jane",
      "merchantSlug": "alexanderjane",
      "status": "running",       // queued|running|awaiting_input|completed|failed|cancelled
      "createdAt": "2026-04-22T14:35:00Z",
      "startedAt": "2026-04-22T14:35:01Z",
      "completedAt": null,
      "templateIds": ["H76ZS6"],
      "flowIds": ["VeffyL", "YkSGTf"],
      "eventCount": 42,
      "summary": null,           // populated when status is terminal
      "error": null,
      "lastEvent": { "seq": 42, "at": "...", "kind": "step", "severity": "info", "payload": {...} },
      "pendingInput": null       // set when status === "awaiting_input" (see §7)
    }
  ]
}
```

Ordered newest-first. This is what powers the dashboard cards.

## 6. `GET /api/jobs/:id/stream` — NDJSON stream

Replays historical events, then streams new ones until job reaches a terminal state OR the client disconnects.

Optional `?since=N` — only emit events with `seq > N` (useful for resume after reconnect).

Same event shapes as §4 but wrapped in a unified envelope:
```json
{ "seq": 12, "at": "2026-04-22T14:35:03Z", "kind": "imported", "severity": "success", "payload": { "id": "...", "name": "...", "templateId": "..." } }
```

**Severity** is auto-derived from kind:
- `exported`, `imported`, `flow_imported`, `fonts_done`, `done` → `success`
- `warn` → `warn`
- `error`, `fail` → `error`
- `needs_input`, `step`, `info`, `log` → `info`

## 7. `POST /api/jobs/:id/inputs` — answer a needs_input prompt

When the pipeline needs user input, it emits a `needs_input` event and pauses the job (`status` transitions to `awaiting_input`). The event payload looks like:

```json
{
  "seq": 17,
  "kind": "needs_input",
  "severity": "info",
  "payload": {
    "input": {
      "id": "5a94...",                 // submit this back to resolve
      "questionKey": "transactional-routing",  // same key = reuse answer across items
      "question": "Flow 'Key Fulfillment' has a send-email step marked transactional. Route it through Redo's transactional send path?",
      "context": "Transactional emails bypass merchant unsubscribe state…",
      "type": "boolean",              // "text" | "choice" | "boolean"
      "options": null,                // present when type === "choice"
      "default": "false",
      "itemId": "KEYfL9",
      "itemLabel": "Key Fulfillment"
    }
  }
}
```

**Client POSTs the answer:**
```json
POST /api/jobs/:id/inputs
{ "inputId": "5a94...", "answer": "true" }
```

Response: `{ "ok": true }` (200) or `{ "ok": false, "error": "..." }` (400).

Job resumes. If another item in the same job triggers the same `questionKey`, the answer is reused automatically (ask-once-per-key).

## 8. `DELETE /api/jobs/:id` — remove a job

Removes a completed/failed job from the list. Response: `{ "ok": true }`.

## 9. `POST /api/run` — LEGACY streaming endpoint

Unchanged from the previous version of this doc. Kept for backward compat with the existing inline HTML UI. New Replit dashboard should use `/api/jobs` + `/api/jobs/:id/stream`.

---

# (below: original /api/run NDJSON description, now legacy)

## LEGACY: `POST /api/run` — execute the import (streams NDJSON)

**Request:**
```json
{
  "klaviyoKey": "pk_...",              // required
  "storeId": "69dff28302f64f42e6012a4d",// required — Redo team/store ID
  "merchantSlug": "alexanderjane",     // required — working dir name
  "templateIds": ["H76ZS6"],           // optional — standalone templates to import
  "flowIds": ["VeffyL"],               // optional — full flows to import
  "redoJwt": "eyJ...",                 // required for RPC import (Replit / self-serve)
  "redoServerBase": "https://app-server.getredo.com", // optional; defaults to prod
  "anthropicKey": "sk-...",            // optional if server already has one
  "skipAi": true,                      // optional; default true
  "runImport": true                    // optional; default true. false = export only
}
```

At least one of `templateIds` / `flowIds` is required. If only flows are selected, the template phase is skipped entirely.

**Response:** `application/x-ndjson` — one JSON event per line. Keep the connection open and stream events to the UI.

### Event kinds

Every event has a `kind` field. Here are all the kinds to handle:

| Kind | Emitted during | Shape |
|---|---|---|
| `step` | Any phase start | `{kind:"step", label:"Fetching Klaviyo account…"}` |
| `info` | Informational | `{kind:"info", text:"..."}` |
| `warn` | Non-fatal warning | `{kind:"warn", text:"..."}` |
| `error` | Fatal error | `{kind:"error", text:"..."}` (run aborts after) |
| `log` | Server log line | `{kind:"log", source:"stdout"\|"stderr", text:"..."}` |
| `exported` | Template exported from Klaviyo | `{kind:"exported", id, name, sectionCount, warnings, unsupported, reviewItems, aiRewrites, fontPlanEntries:[{family,available}]}` |
| `fail` | Single item failed | `{kind:"fail", id, name, error}` |
| `summary` | After template export phase | `{kind:"summary", exported:N, failed:M}` |
| `fonts_done` | After font batch upload | `{kind:"fonts_done", uploaded, registeredFamilies, skipped, unresolved:[{family,reason,usedBy}]}` |
| `imported` | Single template imported via RPC | `{kind:"imported", id, name, templateId}` |
| `flow_imported` | Single flow imported via RPC | `{kind:"flow_imported", id, name, flowId, createdTemplateCount, blankTemplateCount, warningCount}` |
| `done` | Run complete | `{kind:"done", importMethod:"rpc", imported, importFailed, flowsImported, flowsFailed}` |

### Lifecycle

A typical run emits events in this order:

```
step: "Fetching Klaviyo account…"
info: "Account: Alexander Jane"
step: "Downloading H76ZS6…"
step: "Exporting Newsletter #4…"
exported: {id, name, sectionCount: 24, warnings: 3, ...}
(repeat per template)
summary: {exported: 3, failed: 0}
step: "Uploading brand fonts…"
fonts_done: {uploaded: 5, registeredFamilies: 2, unresolved: []}
step: "Creating templates…"
step: "Importing Newsletter #4…"
imported: {id, name, templateId: "abc123"}
(repeat per template)
step: "Fetching Klaviyo metrics…"
step: "Fetching flow VeffyL…"
step: "Parsing Shopify | Welcome Flow Email…"
step: "Importing Shopify | Welcome Flow Email…"
flow_imported: {flowId: "xyz789", createdTemplateCount: 7, blankTemplateCount: 0, warningCount: 9}
(repeat per flow)
done: {importMethod: "rpc", imported: 3, flowsImported: 1, ...}
```

---

## UI design notes

### Ideal selection UX (per Michael's vision)

1. Two tabs: **Templates** / **Flows** — each with its own selectable list
2. Selection sets accumulate across tabs (you can select 3 templates AND 2 flows before clicking Import)
3. A persistent counter at top: "5 selected (3 templates, 2 flows)"
4. Import button submits both `templateIds` + `flowIds` in one request
5. Progress pane visible while request streams

### Concurrent runs

The current backend is single-process; each `POST /api/run` is one long-running request. If the user wants to kick off a second batch while the first runs, the simplest path is to open a second streaming request in parallel (the server handles it). A more robust job model (queue, per-job status, retries) is out of scope for this MVP — the backend comment in the plan doc calls this out.

### Mid-run user input

Not needed for v1. The backend's current touchpoints (discount prefix, org name) happen during template parse which currently uses defaults or config. If/when we add interactive prompts, the server would emit `prompt:{id, question, choices}` and the UI would `POST /api/run/:id/inputs`.

### Getting the Redo JWT

The existing UI has a help text that says (paraphrased): *"In Chrome, open the Redo admin at app.getredo.com while logged in. Open DevTools → Application → Local Storage → `https://app.getredo.com` → copy the value of `redo.merchant_auth_token.<teamId>`."* Keep this.

### Status badges for flow rows

- `live` → green
- `manual` → blue (campaign mode)
- `draft` → gray
- `disabled` → muted
- Use the existing dark theme (#0d1117 background, #e6edf3 text) if consistency matters

---

## When the UI is ready

Send me the component code (React / vanilla — whatever Claude design produces) and I'll wire it into the server's static HTML delivery. Or if it's a separate SPA, I'll switch `GET /` to serve the build output and add a CORS config.

Open items to confirm in design:
- Do we show flow-email previews inline (expandable) or in a drawer on hover?
- Is the progress log a scrolling text area (current) or a structured stepper?
- Should templates inside imported flows be selectable as standalone too, or strictly preview-only?

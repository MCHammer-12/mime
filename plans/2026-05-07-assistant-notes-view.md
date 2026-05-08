# Plan: Assistant notes view

**Status:** Draft v3
**Created:** 2026-05-07
**Updated:** 2026-05-07 — auth via obscure-URL-token; assist at /, admin moved; preview dropped

## Context

Today the migration UI ("Toby 2.0") is the ops console at `/`: connect Klaviyo, run imports, see jobs stream, attach troubleshoot notes, download bundles.

We want a second surface for **external assistants** who help review the imported emails and flows. They:
- Don't run imports.
- Per imported item (template or flow), write a free-text note.
- Should not see internal branding. Page header just reads "redo".
- Notes they write should land in the same DB so Michael's existing dashboard sees them.

## Locked decisions (from 2026-05-07 conversation)

- **`/` becomes the assist page.** External assistants land there by default.
- **Admin (current Toby 2.0 UI) moves to an obscure URL.** Path is `/<ADMIN_URL_TOKEN>/` where the token is an unguessable env var. Loading that URL sets an `admin_token` cookie. Admin API endpoints require the cookie.
- **Both URLs sit inside the existing Replit Private Deployment.** No change to deployment-level gating. No Replit Auth integration. Single deployment.
- **Per-row content: name + note only.** No status, no email preview, no iframes. Same minimal shape as the current note column.
- **Failed items hidden** (assist queries filter `state = 'imported'`).
- **Notes are item-scoped via the latest job** (current job-scoped storage; re-imports start fresh — V1 acceptable).
- **Author identity: optional `?as=<name>` query param.** Each assistant bookmarks their own URL (`/?as=alex`, `/?as=jordan`); the param is captured in JS and sent with each note save. Anonymous if param missing. Trust-based — no real auth — but free.

## Existing infrastructure to reuse

- `JobState.notes: Record<itemId, string>` — already wired ([jobs.ts:113](src/migrate/jobs.ts:113), 299).
- `POST /api/jobs/:id/notes` — already exists ([server.ts:1770](src/migrate/server.ts:1770)). Reused server-side, called by a new assist-shaped wrapper.
- Postgres `jobs.notes` JSONB — migration 002, already run.
- Job hydration from DB on server boot ([jobs.ts:414](src/migrate/jobs.ts:414)).
- Static asset serving via `tryServeStatic`.

## Approach

### 1. Route layout

```
GET  /                           → assist HTML  (assist.html)
GET  /api/assist/*               → assist endpoints (open within the deploy)
GET  /<ADMIN_URL_TOKEN>/         → admin HTML  (existing index.html), sets admin_token cookie
GET  /<ADMIN_URL_TOKEN>/...      → admin static assets, gated by cookie OR same path token
GET  /api/jobs/*                 → admin endpoints, gated by admin_token cookie
POST /api/run, /api/templates,
     /api/flows*, /api/campaigns → admin endpoints, gated by admin_token cookie
```

Behavior:
- Visiting `/<ADMIN_URL_TOKEN>/` sets `admin_token=<value>` HttpOnly cookie, then serves the existing UI shell.
- Without the cookie, every admin API endpoint returns 401.
- The assist UI never sends the cookie because it's served from `/` and the admin URL never gets visited from there.
- Token rotation: change `ADMIN_URL_TOKEN` env var → old cookies invalid → old URL no longer matches → must reload from new URL.
- Local dev: if `ADMIN_URL_TOKEN` is unset, admin gating is bypassed (fall back to current behavior).

### 2. New `imported_items` table — flat list of what's been imported

Today the only place item names live is inside event payloads (`exported`, `flow_imported`). Joining across jobs to produce the assist's flat list would mean scanning all events. Cheaper to denormalize at write time.

**Migration 003:**
```sql
CREATE TABLE imported_items (
  id BIGSERIAL PRIMARY KEY,
  store_id TEXT NOT NULL,
  store_name TEXT NOT NULL,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,                 -- klaviyo template/flow id
  item_type TEXT NOT NULL,               -- 'template' | 'flow'
  name TEXT NOT NULL,
  state TEXT NOT NULL,                   -- 'imported' | 'failed'
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (store_id, item_id, job_id)
);
CREATE INDEX idx_imported_items_store ON imported_items (store_id, imported_at DESC);
```

Write path: in the import pipeline ([server.ts:880](src/migrate/server.ts:880) for templates, the flow-import handler for flows), insert a row whenever an item lands.

Backfill: not needed. The assist view starts with whatever lands from now on; old runs can be re-imported if you want them to appear.

### 3. Notes shape upgrade — author + savedAt

Today `jobs.notes` is `Record<itemId, string>`. Upgrade to a structured value:
```ts
type NoteValue = string | { text: string; author?: string; savedAt: string };
```

- Read path coerces legacy strings to `{ text }`.
- Write path stores the structured form.
- `setNote(jobId, itemId, note, author?)` accepts the optional author.
- Toby dashboard's troubleshoot panel reads either shape and shows the author when present.

### 4. New assist API (`/api/assist/*`)

- `GET /api/assist/stores` → `{ storeId, storeName, lastImportedAt, itemCount }[]`. Aggregated from `imported_items`.
- `GET /api/assist/stores/:storeId/items` → `{ itemId, itemType, name, importedAt, latestJobId, note: { text, author, savedAt } | null }[]`. Filtered to `state = 'imported'`. Latest-job-per-item join with `jobs.notes`.
- `POST /api/assist/stores/:storeId/items/:itemId/note` → body `{ note: string, author?: string }`. Server resolves the latest job for `(storeId, itemId)` and calls `setNote(jobId, itemId, note, author)`. Empty string clears.

No DELETE endpoint; clearing happens via empty-string POST. No batch update.

### 5. UI — `assist.html` + new components

```
src/migrate/ui/assist.html                    NEW  — minimal HTML shell, "redo" wordmark
src/migrate/ui/components/assist-app.jsx      NEW  — root: hash router, store picker, store detail
src/migrate/ui/components/assist-stores.jsx   NEW  — card grid (mirrors existing Stores layout)
src/migrate/ui/components/assist-items.jsx    NEW  — single-list-per-store, name + note expander
```

UI mirrors the current `Stores` view: card grid with brand name + last-imported sub-line, no "Add store" tile, no "internal · ops" badge. Header reads `redo`. Brand detail is one scrollable list (templates and flows mixed, sorted by recently imported), each row showing item name and a note textarea that saves on blur.

The `?as=alex` query param is read once from `window.location` on app boot, stored in app state, and sent with every note POST. The "saved by" line under the textarea reflects what came back from the server.

### 6. Files

```
src/migrate/auth.ts                           NEW  — admin cookie middleware + token check
src/migrate/db.ts                             EDIT — migration 003 (imported_items)
src/migrate/jobs.ts                           EDIT — setNote takes optional author; structured note shape
src/migrate/imported-items.ts                 NEW  — write + read helpers for imported_items
src/migrate/server.ts                         EDIT — admin gating; /assist routes; /api/assist/* routes
src/migrate/import-rpc.ts                     EDIT — record imported_items on each successful template/flow import
src/migrate/ui/assist.html                    NEW
src/migrate/ui/components/assist-app.jsx      NEW
src/migrate/ui/components/assist-stores.jsx   NEW
src/migrate/ui/components/assist-items.jsx    NEW
```

## Alternatives considered

- **Replit Auth headers + dual allowlist.** Stronger guarantees but requires going public on Replit, which is ruled out. (Could work in private mode using injected `X-Replit-User-*` headers, but adds ~150 lines and forces all assistants to make Replit accounts.)
- **Two separate Replit deployments.** Cleanest separation but doubles deploy cost and management overhead.
- **Admin stays at `/`, assist at obscure URL.** Rejected — assistants who type the bare deployment URL would land on admin and could see Klaviyo keys / Redo JWTs in form fields.
- **Both URLs obscure, `/` returns 404 or placeholder.** Equivalent to the chosen approach but slightly worse UX for assistants (must remember a non-root URL).
- **Per-assistant magic links.** Nice for revocation per-person but more state to track. Defer.
- **Email preview in iframe.** Dropped per Michael — too much new plumbing for a feature that's not core to the note-writing flow.
- **Separate `assistant_notes` table.** Cleaner survival across re-imports, but the existing dashboard would need to learn a new shape. Defer.

## Sections (work breakdown)

1. **Auth foundation.** New `auth.ts` with `requireAdminCookie` middleware. Wire onto existing admin endpoints. Move admin entry point to `/<ADMIN_URL_TOKEN>/`. Verify the existing UI still loads via the new URL.
2. **Migration 003 + write path.** Add `imported_items` table; helpers for insert. Wire into the import pipeline at the points where `exported` / `flow_imported` events are emitted today.
3. **Notes shape upgrade.** `setNote` signature gains optional author; structured stored value; legacy-string coercion in readers; Toby panel renders the author line.
4. **Assist API endpoints.** Three routes; smoke-test with curl.
5. **Assist SPA shell.** `assist.html`, three components, hash routing, brand-card grid.
6. **Brand detail + notes UX.** Items list, save-on-blur textarea, `?as=` capture, "saved by" line.
7. **Deploy.** Set `ADMIN_URL_TOKEN` env var on Replit. Document the URL for Michael's bookmark. Distribute the bare deploy URL (with `?as=…` per assistant) to the assistant pool.
8. **Manual QA.** See Verification.

## Verification

- Visiting `/` → assist UI loads. No Klaviyo key field. No "Toby 2.0".
- Visiting `/<ADMIN_URL_TOKEN>/` → admin UI loads, identical to today.
- Visiting `/<ADMIN_URL_TOKEN>/` once, then bare-domain admin API calls (`/api/jobs`) succeed. Visiting `/` then the same calls → 401.
- Admin URL with a wrong token → 404.
- Brand picker shows ≥1 brand from a fresh import. Click in → list of imported items, no failed items.
- Writing a note in `/?as=alex` → POST returns saved value with `author: "alex"`. Refresh → note + "saved by alex" persists.
- Same note appears in the Toby dashboard's troubleshoot panel for that job, with author visible.
- Re-importing a template starts the new job's note empty; the old job's note remains intact in the DB (and visible in Toby's job-history view).
- Rotating `ADMIN_URL_TOKEN` and restarting → old admin URL 404s, old admin cookies rejected; reload from new URL works.

## Open questions

None blocking. Optional follow-ups:
- V2: per-assistant magic links instead of `?as=`.
- V2: email preview, if assistants need it without bouncing to Redo.
- V2: `assistant_notes` table so re-imports don't reset the note.

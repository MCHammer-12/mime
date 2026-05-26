# Reviewer dashboard — public deploy for external reviewers

**Date drafted:** 2026-05-26
**Status:** Plan — not started
**Driver:** External (non-Redo, non-Replit) reviewer needs to add a store, run imports, and leave feedback on the parser output without exposure to the internal admin or assist surfaces.

## Goal

Stand up a stripped-down dashboard at a public URL where a non-Replit person can:
1. Authenticate via a per-reviewer token URL
2. Add their own store (Klaviyo + Redo creds)
3. Pick flows + templates to import
4. Run the import (NDJSON job stream like today)
5. Leave per-item feedback notes
6. Export troubleshoot bundles

They never see: hours saved tally, other reviewers' work, identity claims, the admin Stores list, drag-reorder, "View as" picker, or any merchant data they didn't add themselves.

## Architecture

**Two Replit Autoscale deployments, one repo, one Postgres.**

| | Existing private deploy | New public deploy |
|---|---|---|
| URL | `daniel2-0.replit.app` | `mime-review.replit.app` (TBD) |
| Privacy | Replit Private | Replit public (Autoscale, no workspace gate) |
| `MIME_SURFACE` env var | unset / `admin` | `public_review` |
| Routes registered | Existing (admin, assist, import, debug) | Only reviewer routes (`/r/...`, `/api/r/...`) |
| UI served | Existing Toby 2.0 + assist | New `reviewer-shell.html` |
| Postgres | shared | shared |
| Cookies | `admin_token`, `admin_user`, `admin_claim` | `reviewer_token` (scoped per reviewer) |

**Why two deploys instead of one with a surface flag at request time:**
Lower risk. A flag on each route handler is one careless `if` away from a leak. A surface-mode env var that controls which `app.get(...)` calls run at boot means admin endpoints literally don't exist on the public process — no possible leak from a routing bug. Same code, same DB; different `runMigrations() + registerRoutes()` selection at startup.

## DB schema additions

Two new things, both append-only migrations:

### Migration `010_reviewers.sql`
```sql
CREATE TABLE IF NOT EXISTS reviewers (
  id            TEXT PRIMARY KEY,            -- short slug, e.g. "alice-bravo"
  name          TEXT NOT NULL,               -- display name, "Alice Bravo"
  token         TEXT NOT NULL UNIQUE,        -- random URL token (long, opaque)
  email         TEXT,                        -- optional, free-text label
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at   TIMESTAMPTZ
);
```

Admins create rows here via psql or a small admin-side endpoint (Phase 1 stretch). The token is what the reviewer types into the URL.

### Migration `011_stores_reviewer.sql`
```sql
ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS created_by_reviewer TEXT
    REFERENCES reviewers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_stores_created_by_reviewer
  ON stores(created_by_reviewer)
  WHERE created_by_reviewer IS NOT NULL;
```

A store row with `created_by_reviewer` set is visible to:
- That reviewer (and only that reviewer)
- Admin (admin sees everything, with a "by Alice (reviewer)" badge for clarity)

Existing stores have `created_by_reviewer = NULL` → unchanged behavior on the private deploy.

### Tagging notes / feedback

`jobs.notes` already accepts `{text, author, savedAt}` (StoredNote shape). The reviewer is just another author. No schema change needed; the reviewer's display name lands in `author` so admin sees who wrote what.

Optional follow-up if you want stricter separation: a `reviewer_feedback` table keyed by `(job_id, item_id, reviewer_id)`. Skipping in V1 — `jobs.notes` works and stays consistent with Dennis/Toby.

## Auth model

**Per-reviewer URL token, set into a cookie.** Modeled on existing `ADMIN_URL_TOKEN`.

Flow:
1. Admin runs `INSERT INTO reviewers (id, name, token) VALUES ('alice-bravo', 'Alice Bravo', '<random>')` (or hits a new admin-side endpoint in a later phase)
2. Admin emails reviewer: `https://mime-review.replit.app/r/<random>/`
3. Reviewer visits → `requireReviewerToken` handler reads the token from the URL, looks up the row, sets `reviewer_token` HttpOnly cookie (1y expiry), redirects to `/dashboard`
4. Subsequent visits: cookie carries the token; no URL token needed
5. All `/api/r/*` endpoints check the cookie via `requireReviewer(req, res) → { reviewerId, reviewerName }`
6. Revocation: admin sets `disabled_at` on the reviewer row → next API call 401s

Same shape as Toby 2.0's admin gate, just per-reviewer instead of single-shared. No basic-auth on the public deploy (the URL token IS the credential).

## Routes (public deploy only)

**HTML**
- `GET /` — landing page with a "Paste your link" message. No useful UI without a valid token.
- `GET /r/<token>/` — token handshake, sets cookie, redirects to `/dashboard`
- `GET /dashboard` — main app shell (single-page React, served from `reviewer-shell.html`)

**API (all require reviewer cookie)**
- `GET  /api/r/me` — `{ reviewerId, reviewerName }`
- `GET  /api/r/stores` — stores owned by this reviewer
- `POST /api/r/stores` — add a store (Klaviyo key, Redo JWT, store ID); sets `created_by_reviewer`
- `PATCH /api/r/stores/:id` — edit creds (only on reviewer-owned stores)
- `DELETE /api/r/stores/:id` — delete (only on reviewer-owned)
- `POST /api/r/flows` — list Klaviyo flows for one of their stores (mirrors `/api/flows`)
- `POST /api/r/templates` — list Klaviyo templates for one of their stores
- `POST /api/r/import` — kick off an import job for selected items
- `GET  /api/r/jobs/:id/stream` — NDJSON job stream
- `GET  /api/r/jobs` — their jobs
- `GET  /api/r/jobs/:id/items` — items with notes
- `POST /api/r/jobs/:id/items/:itemId/note` — leave feedback
- `POST /api/r/jobs/:id/bundle` — download troubleshoot zip

All `/api/r/*` calls reject if `:storeId` or `:jobId` belongs to a store with `created_by_reviewer != currentReviewer.id`. Single source-of-truth scoping helper: `assertReviewerOwns(reviewerId, storeId)`.

**Existing routes that 404 on public deploy** — admin, assist (`/api/assist/*`), import wizard (`/api/flows`, `/api/templates`, etc.), debug (`/api/debug/*`). Not registered when `MIME_SURFACE === "public_review"`.

## UI

New directory: `src/migrate/ui/reviewer/`. Mirrors `src/migrate/ui/` structure but stripped down.

Components needed (heavy reuse from existing where possible):
- `dashboard.jsx` — stores list + "Add store" button (reuse existing `setup-modal.jsx` with `?role=reviewer` flag if it's clean, else duplicate)
- `store-detail.jsx` — flows + templates pickers, "Import" button, job progress (reuse parts of existing `import-stream` / `flows-stream` UI)
- `items-list.jsx` — imported items per store with a note textarea per item (reuse existing assist note pattern)
- `topbar.jsx` — reviewer's display name, sign-out (clears cookie)

Kept out:
- Hours saved chip
- Identity claim modal
- "View as Dennis/Toby" picker
- Drag-reorder
- Mine/All filters (everything they see IS theirs)
- Multi-reviewer comments

Visual: same monochrome admin theme, but tighten the chrome — no "internal · ops" badge, no env/AI status pills. Should feel like a focused tool, not the internal cockpit.

## Phasing

Each phase is mergeable on its own.

### Phase 1: Surface routing + reviewer auth
**Goal:** Deploy the public process, reviewers can authenticate via token URL, no admin endpoints reachable.
- [ ] Add `MIME_SURFACE` env var read at boot
- [ ] Refactor `server.ts` route registration into a `registerRoutes(surface)` function that skips admin/assist endpoints when `surface === "public_review"`
- [ ] Migration 010: `reviewers` table
- [ ] `src/migrate/reviewers.ts` repo (CRUD + token lookup)
- [ ] `requireReviewer(req, res)` middleware (cookie lookup + disabled check)
- [ ] `GET /r/<token>/` handshake → cookie + redirect
- [ ] `GET /api/r/me`
- [ ] Stub `/dashboard` HTML (just shows "Hi Alice")
- [ ] Provision the second Replit deployment; set `MIME_SURFACE=public_review`, point to same Postgres
- [ ] Manual verification: visiting `/admin`, `/api/me`, `/api/assist/stores` returns 404 on public deploy

**Verify:** Reviewer's URL works, admin URLs 404 on public deploy, admin UI on private deploy unchanged.

### Phase 2: Reviewer-scoped stores
**Goal:** Reviewer can add and manage their own store; data is isolated.
- [ ] Migration 011: `stores.created_by_reviewer` column
- [ ] `assertReviewerOwns(reviewerId, storeId)` helper
- [ ] `GET /api/r/stores` (filtered by `created_by_reviewer = ?`)
- [ ] `POST /api/r/stores` (sets `created_by_reviewer`)
- [ ] `PATCH /api/r/stores/:id` + ownership check
- [ ] `DELETE /api/r/stores/:id` + ownership check
- [ ] Admin dashboard: badge reviewer-owned stores with `· created by Alice (reviewer)` — minor cosmetic update, optional
- [ ] Dashboard UI: stores list + "Add store" modal (reduced version of existing setup-modal)

**Verify:** Reviewer adds a store; admin sees it in their list with reviewer badge; reviewer doesn't see admin-owned stores; another reviewer doesn't see this reviewer's stores.

### Phase 3: Import pipeline (reviewer-scoped)
**Goal:** Reviewer can list Klaviyo content and run an import.
- [ ] `POST /api/r/flows` and `POST /api/r/templates` — wrap existing helpers with ownership check
- [ ] `POST /api/r/import` — wrap `runImport()` (existing pipeline) but scope by reviewer
- [ ] `GET /api/r/jobs` + `GET /api/r/jobs/:id/stream`
- [ ] Dashboard UI: flow/template picker + import button + live job stream
- [ ] Smart sending + needs-input modal flow (existing patterns)

**Verify:** Reviewer imports a real Klaviyo flow into a real Redo store, NDJSON stream works, job completes, no admin features bleed in.

### Phase 4: Feedback + bundles
**Goal:** Reviewer can leave per-item notes and export bundles.
- [ ] `POST /api/r/jobs/:id/items/:itemId/note` — uses existing `setJobNote()` with `{author: reviewerName}`
- [ ] `GET /api/r/jobs/:id/items` — list imported items with notes (reviewer's own notes only, or all — see open question below)
- [ ] `POST /api/r/jobs/:id/bundle` — same `streamBundle()` as admin
- [ ] Dashboard UI: items list with note textarea + "Download bundle" button

**Verify:** Reviewer leaves a note; admin sees it on their side; bundle downloads with the source HTML and feedback note included.

## Non-goals / explicit out-of-scope

- **No reviewer-to-reviewer collaboration.** Each reviewer sees only their own stores. No shared workspaces, no @mentions.
- **No identity claim / slot lock.** The URL token IS the identity. Anyone with the link is that reviewer. Compromise = rotate the token.
- **No hours saved tally** on the reviewer view.
- **No drag-reorder.** They have one store (or few) — list order is creation order.
- **No emails.** Admin shares the URL out-of-band (Slack, email, whatever).
- **No campaign imports.** Reviewer V1 is flows + templates only. Add later if needed.

## Open questions

1. **Reviewer onboarding UX.** Phase 1 has admin INSERTing rows via psql. Worth a Phase 1 stretch: `POST /api/admin/reviewers { name }` returns the URL. Probably yes for usability, but not blocking.
2. **Note visibility on the reviewer side.** When admin (Toby/Dennis) leaves a note on an item the reviewer imported, does the reviewer see it? I'd default to yes (they should know if you've already flagged something) but flag it for your call.
3. **Anthropic API key on the public deploy.** Required for AI rewrites during import. Two options: (a) reuse the same `ANTHROPIC_API_KEY` env var on the public deploy (simple, same key) or (b) gate AI off entirely for reviewer imports (no AI rewrites, just deterministic parse). Default (a).
4. **Rate-limiting + abuse.** A public URL with import capability against arbitrary Klaviyo keys is a potential abuse vector — they could import N flows costing N Anthropic calls. Probably not a real concern with a per-reviewer token + small trusted-reviewer set, but worth keeping in mind. Easy mitigation later: per-reviewer monthly job count cap.
5. **Domain.** `mime-review.replit.app` is a placeholder. Replit gives you a default subdomain when you spin up the Autoscale deployment.
6. **Bundle source-pruning.** PR #71 prunes template source from event payloads after first bundle export. This stays on the reviewer surface too — the reviewer downloads once, gets the canonical zip, subsequent bundles are degraded. Consistent with admin behavior.

## Estimated effort

- Phase 1: 1 working day (routing refactor is the most contained piece)
- Phase 2: 1 working day
- Phase 3: 1-2 working days (UI carry-over from existing import wizard is most of the work)
- Phase 4: half day

~3-4 working days total. Could ship Phase 1+2 as a "shell only" early to get the deploy validated before pulling the import pipeline in.

## Risk

Lowest-risk path because the architecture is dual-deploy with a surface-mode env var. If anything goes sideways on the public deploy, the private admin deploy is untouched. The only shared state is Postgres, and the new tables are append-only + the `stores.created_by_reviewer` column is nullable + indexed only on non-null rows — zero impact on existing reads.

Biggest unknown is the routing refactor in `server.ts` (Phase 1). The file is currently a flat list of `if (req.method === ... && req.url === ...)` blocks. Cleaner would be to push these into an array of `{method, pattern, handler, surfaces}` and filter at registration time. I'd recommend doing that refactor as part of Phase 1 — it's the right structural fix anyway, and makes the surface-mode split clean.

# Plan: Vercel-deployed assist surface

**Status:** Draft
**Created:** 2026-05-08

## Context

External assistants need access to the `/assist` UI for note-taking on imported merchants. Today `/assist` is served from the Replit deploy and gated by Replit's Private Deployment fence. Adding new assistants to the Replit workspace requires per-seat upgrades that don't make sense for a small, churn-prone assistant pool.

**Goal:** stand up a separate Vercel deploy that serves the assist UI + its own thin API. It reads the same Postgres DB the Replit deploy writes to, so notes and checkmarks land in the existing tables and surface in the Toby admin dashboard automatically.

**Out of scope:** the admin (Toby) UI, jobs, imports, anything that runs `runMigrations()`. Replit stays the source of truth for schema. Vercel reads only.

## Decisions

- **Repo layout:** new top-level `vercel/` directory in this repo. Vercel project root = `vercel/`. Separate `package.json` so deps don't bloat the main app.
- **DB driver:** `@neondatabase/serverless` (HTTP-based, no connection pool). Replit's Postgres is Neon-hosted; the connection string from `DATABASE_URL` works directly.
- **Migrations:** never run from Vercel. Tables `imported_items` and `assist_completions` are assumed to exist (Replit creates them on boot). If a query hits a missing table, return 503 with a clear error.
- **Auth:** URL-token query param. `?t=<ASSIST_TOKEN>` validates against env var; missing/wrong → 401. Token is in every request (UI propagates it the same way `?as=` is propagated today). No cookies.
- **Identity:** same `?as=Dennis` / `?as=Toby` mechanism as the Replit version. URL contains both: `https://redo-notes.vercel.app/?t=…&as=Dennis`.
- **Scope:** assist-only. The 4 endpoints (`stores`, `items`, `note`, `done`) are all that's needed. Admin endpoints (jobs, stores CRUD, etc.) stay on Replit, behind admin-cookie auth.

## Architecture

```
vercel/
  package.json              { @neondatabase/serverless, @vercel/node }
  vercel.json               (rewrites for static SPA, optional)
  tsconfig.json             tsx → js
  api/
    assist/
      stores.ts             GET  /api/assist/stores
      items.ts              GET  /api/assist/stores/[storeId]/items
      note.ts               POST /api/assist/stores/[storeId]/items/[itemId]/note
      done.ts               POST /api/assist/stores/[storeId]/items/[itemId]/done
    _lib/
      db.ts                 sql template tag wrapper around @neondatabase/serverless
      auth.ts               token check + ?as= reader (one-line guards)
      notes.ts              coerceNote helper (lifted from src/migrate/jobs.ts)
  public/
    index.html              the assist shell (renamed from assist.html, "/" entry)
    components/
      atoms.jsx             icons + relDate (copy from src/migrate/ui/components/)
      assist-app.jsx        edited: capture ?t= + propagate to API calls
      assist-stores.jsx     copy as-is
      assist-items.jsx      copy as-is
    fonts/                  copy of src/migrate/ui/fonts/
```

### API conversion sketch

Each Replit handler in `imported-items.ts` becomes a Vercel function. Pattern:

```ts
// vercel/api/assist/stores.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { neon } from "@neondatabase/serverless";
import { requireToken, readAs } from "../_lib/auth";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireToken(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const sql = neon(process.env.DATABASE_URL!);
  const as = readAs(req);
  const rows = as
    ? await sql`/* with-assistant SQL from imported-items.ts */`
    : await sql`/* fast-path SQL */`;
  res.json({ stores: rows.map(r => /* shape */) });
}
```

The SQL is lifted verbatim from `src/migrate/imported-items.ts` — same schema, same query.

### Routing

Vercel default routing handles this for free:
- `/api/assist/stores` → `api/assist/stores.ts`
- `/api/assist/stores/[storeId]/items` → `api/assist/items.ts` reading `req.query.storeId`
- `/api/assist/stores/[storeId]/items/[itemId]/note` → `api/assist/note.ts`
- `/api/assist/stores/[storeId]/items/[itemId]/done` → `api/assist/done.ts`
- `/` → `public/index.html`
- `/components/*`, `/fonts/*` → `public/components/*`, `public/fonts/*`

Need `vercel.json` only if we want catch-all rewrites (we don't — the SPA uses hash routing, no client-side history).

### Auth flow

UI on first load reads `?t=` and `?as=` from `window.location.search`. Stores both in app state. Every API call appends both as query params.

Server-side: each function calls `requireToken(req, res)` which:
- Reads `req.query.t`
- Compares to `process.env.ASSIST_TOKEN` (constant-time compare)
- 401s + writes early return signal if mismatch

Token rotation = change env var on Vercel + re-share new URL. Old links 401 immediately.

## Alternatives considered

- **Keep on Replit, pay for invites.** Cheap if the assistant pool is permanently small (≤2). Linear scaling pain otherwise.
- **Cross-origin fetch from Vercel UI to Replit API.** Requires making the Replit deploy public (which we won't do) or punching a hole. Defer.
- **Cloudflare Pages + Workers.** Equivalent to Vercel functionally. Vercel chosen for Neon partnership and simpler Postgres serverless story.
- **Single Vercel deploy serving everything.** Would require porting the full server (jobs, streaming, RPC, font upload pipeline, etc.) to serverless functions. Way too much surgery for a feature that's working fine on Replit.
- **Self-host on Render/Railway.** Would let us reuse the existing server.ts unchanged. Cheap (~$5/mo) but adds another runtime to manage. Punted.

## Sections (work breakdown)

1. **Scaffold `vercel/` directory** — package.json, tsconfig, _lib helpers, copy public assets.
2. **Lift the 4 API endpoints** — `stores`, `items`, `note`, `done`. Each function ports the SQL from `imported-items.ts` and the request handling from `server.ts`.
3. **Update `assist-app.jsx`** to read + propagate `?t=` alongside `?as=` on every API call.
4. **Local smoke test** — `vercel dev` against a local DATABASE_URL pointing at the dev DB or a temporary copy.
5. **Walk Michael through Vercel signup** (~30s, GitHub login).
6. **`vercel link` + `vercel deploy`** — I drive the CLI once Michael's logged in.
7. **Set Vercel env vars:** `DATABASE_URL` (paste from Replit secrets), `ASSIST_TOKEN` (generate something random).
8. **Smoke test live** — visit the deploy URL, verify brand picker loads, write a test note, confirm it shows in Replit's Toby dashboard.
9. **Hand off URLs** — `https://<project>.vercel.app/?t=<ASSIST_TOKEN>&as=Dennis` for each assistant.

## Verification

- `https://<deploy>/?t=<bad>` → 401 / "access denied" page.
- `https://<deploy>/?t=<good>&as=Dennis` → brand picker loads, identical to the Replit version.
- Brand detail: items render with `done` state per assistant; checkbox toggle persists.
- Note write: shows up in Toby's troubleshoot panel for the same job, attributed to the assistant.
- Toby's Hours-saved counter still increments (it reads from `imported_items.email_count`, populated by Replit).
- Delete the Vercel deploy and Replit /assist still works (kept around as a fallback).

## Open questions

- **Keep `/assist` on Replit too?** Yes, for now. Both deployments coexist; Replit's `/assist` is identical and useful as a fallback / staging environment. We can remove it later if Vercel proves out.
- **Dev DB copy or share live DB?** Local `vercel dev` will point at the live Replit Neon DB by default. That's fine for read-only smoke tests but writes go to prod. Plan: add a separate Neon branch for Vercel local dev if write-testing becomes a real workflow. Not blocking V1.
- **Domain.** Default `<project>.vercel.app` is fine. Custom domain is a click + DNS later.

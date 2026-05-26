# mime — agent rules

## Database

**Schema source of truth: [`src/migrate/db.ts`](src/migrate/db.ts) `MIGRATIONS` array.**
Append-only, raw SQL. Each migration is idempotent (`CREATE TABLE IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`) and runs at server boot via `runMigrations()`.

### Hard rules

- **Never run direct DDL** against the dev or prod database. No
  `DROP TABLE`, `ALTER TABLE`, `CREATE TABLE` outside the migrations array.
  Anything you change via SQL console is invisible to the codebase and creates
  drift that will burn the next deploy.
- **To change schema, append a migration** to the `MIGRATIONS` array with the
  next sequential number (e.g. `006_<feature>`). Use `IF NOT EXISTS` /
  `IF EXISTS` so re-running is safe. Never edit a previous migration's SQL —
  rows in flight depend on it.
- **Never click "Approve and publish"** on Replit's auto-generated schema-diff
  prompt. That tool diffs the dev DB against the prod DB, doesn't know about
  our migration list, and routinely proposes destructive operations (e.g.
  `DROP TABLE stores CASCADE`). Skip it. Deploy normally — `runMigrations()`
  handles schema.
- **If you find yourself drifting**: don't try to fix prod with a one-off SQL
  statement. Add a migration, push, deploy. The boot-time runner takes care of
  it.

### Why no Drizzle / Prisma / etc.

The project predates needing one. The MIGRATIONS array is small enough that a
heavier ORM-driven schema would be overhead. If a future change makes that
worth revisiting, that's a separate decision — discuss with Michael first.

## Replit deployment

- Production target is Replit Autoscale.
- Build & start: `npm ci --omit=dev` then `npm start` (= `tsx src/migrate/server.ts`).
- The server runs migrations on boot. Don't bypass the boot path with
  out-of-band SQL.
- Env vars that matter: `DATABASE_URL` (Postgres), `ADMIN_URL_TOKEN` (admin
  gating — see [src/migrate/auth.ts](src/migrate/auth.ts)),
  `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` (optional outer gate).

## Routes

- `/` — assist UI (external assistants, read-mostly + note write).
- `/<ADMIN_URL_TOKEN>/` — admin UI (Toby 2.0). Sets cookie; admin endpoints
  gate on it via `requireAdmin` in [src/migrate/server.ts](src/migrate/server.ts).
- `/admin/` — dev-mode shortcut to the admin UI when `ADMIN_URL_TOKEN` is
  unset. Only used locally.

## Feedback workflow

When a batch of feedback / fixes is ≥5 items or will run across multiple
Claude sessions in parallel, use the planner/executor pattern. One session
plans + writes task files under `plans/feedback/<YYYY-MM-DD>-<short-name>/`;
other sessions execute one task each. Full workflow + templates in
[`plans/feedback/README.md`](plans/feedback/README.md).

For <5 items, do them inline — the structure is overhead.

## Code style

- TypeScript + Node ESM, `tsx` for execution.
- React 18 in-browser via Babel standalone (no build step for the UI). Each
  component file aliases React hooks to per-file names (`useS`, `useC`, etc.)
  so multiple `<script>` tags can share globals without collision.
- Don't add unrequested error handling, fallbacks, or comments. Prefer
  editing existing files over creating new ones.
- Migrations to bumping a UI script's `?v=N` cache-buster live in
  [src/migrate/ui/index.html](src/migrate/ui/index.html) — bump when you
  change the corresponding component file.

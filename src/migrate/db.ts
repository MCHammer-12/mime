/**
 * Postgres-backed persistence for the jobs registry.
 *
 * In Replit (autoscale deploy) the filesystem is stateless, so jobs held in
 * a JS Map vanish between deploys. This module gives us durable storage for
 * job records + the full event log, while keeping the in-memory pub/sub
 * layer for live streams (only the replica that owns a job streams it).
 *
 * DATABASE_URL is the only config. Replit's built-in Postgres auto-injects
 * it. If it's unset (local dev without a DB), the whole module degrades
 * gracefully — `isDbEnabled()` returns false and jobs.ts stays in-memory.
 */

import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | null = null;
let migrationsRun = false;
// Hard kill-switch: once flipped, no more DB calls are attempted for the
// life of the process. Set by `disableDb()` when the DB is provably
// unreachable (e.g. startup migrations failed with a DNS error). This
// stops the pg pool from stacking thousands of failed connection attempts
// on every job event during an import.
let dbDisabled = false;

function buildPool(): pg.Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    return new Pool({
      connectionString: url,
      // Replit Neon requires SSL; the pg default does the right thing when
      // the URL includes sslmode=require, but some Neon connection strings
      // omit that. Default to requiring SSL with relaxed cert verification
      // (the connection is still encrypted; we just don't have a CA bundle
      // for Neon's ephemeral certs).
      ssl: url.includes("sslmode=") ? undefined : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  } catch (e) {
    console.warn("[db] failed to create pool:", e);
    return null;
  }
}

export function isDbEnabled(): boolean {
  if (dbDisabled) return false;
  if (pool) return true;
  pool = buildPool();
  return pool !== null;
}

export function getPool(): pg.Pool {
  if (dbDisabled) {
    throw new Error("DB disabled — getPool() called after kill-switch tripped");
  }
  if (!pool) pool = buildPool();
  if (!pool) throw new Error("DATABASE_URL not set — getPool() called in dev mode");
  return pool;
}

/**
 * Permanently disable DB access for this process. Use when the DB is
 * provably unreachable so subsequent calls don't pile up failed
 * connection attempts. Drains the existing pool best-effort.
 */
export function disableDb(reason: string): void {
  if (dbDisabled) return;
  dbDisabled = true;
  console.warn(`[db] disabled for the rest of this process: ${reason}`);
  const p = pool;
  pool = null;
  if (p) {
    // end() rejects in-flight queries; that's intentional — they were
    // already failing. Swallow any error from end() itself.
    p.end().catch(() => {});
  }
}

const MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: "001_init",
    sql: `
      CREATE TABLE IF NOT EXISTS jobs (
        id UUID PRIMARY KEY,
        store_id TEXT NOT NULL,
        store_name TEXT NOT NULL,
        merchant_slug TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        template_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        flow_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        summary JSONB,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS job_events (
        id BIGSERIAL PRIMARY KEY,
        job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        at TIMESTAMPTZ NOT NULL,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        payload JSONB NOT NULL,
        UNIQUE (job_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_store_created
        ON jobs (store_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_jobs_created
        ON jobs (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_job_events_job
        ON job_events (job_id, seq);
    `,
  },
  {
    name: "002_notes",
    sql: `
      ALTER TABLE jobs
        ADD COLUMN IF NOT EXISTS notes JSONB NOT NULL DEFAULT '{}'::jsonb;
    `,
  },
  {
    // Stores merchant credentials server-side so (a) Claude can run
    // resolver diagnostics autonomously, (b) keys outlive a browser's
    // localStorage, (c) JWT can be edited in one place when it expires
    // and the next run picks up the new value automatically.
    //
    // Threat model: anyone with basic-auth creds can read all keys via
    // GET /api/stores/:id. That's intentional — same access surface as
    // submitting an arbitrary klaviyoKey to /api/run today.
    name: "003_stores",
    sql: `
      CREATE TABLE IF NOT EXISTS stores (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        merchant_slug   TEXT NOT NULL,
        klaviyo_key     TEXT NOT NULL,
        redo_jwt        TEXT,
        store_id        TEXT NOT NULL,
        redo_server_base TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_imported_at TIMESTAMPTZ
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_stores_slug
        ON stores (merchant_slug);
    `,
  },
  {
    // Flat per-store list of successful imports — denormalized at the
    // existing exported / flow_imported / campaign-imported events so the
    // assist read path is one indexed query.
    name: "004_imported_items",
    sql: `
      CREATE TABLE IF NOT EXISTS imported_items (
        id BIGSERIAL PRIMARY KEY,
        store_id TEXT NOT NULL,
        store_name TEXT NOT NULL,
        job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        item_type TEXT NOT NULL,
        name TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'imported',
        imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (store_id, item_id, job_id)
      );
      CREATE INDEX IF NOT EXISTS idx_imported_items_store
        ON imported_items (store_id, imported_at DESC);
      CREATE INDEX IF NOT EXISTS idx_imported_items_lookup
        ON imported_items (store_id, item_id, imported_at DESC);
    `,
  },
  {
    // email_count: how many individual emails this import represents.
    //   - templates / campaign variants = 1
    //   - flows = createdTemplateCount + blankTemplateCount
    // Used for the "hours saved" tally — total time = SUM(email_count) * 20min.
    name: "005_email_count",
    sql: `
      ALTER TABLE imported_items
        ADD COLUMN IF NOT EXISTS email_count INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    // Per-assistant "done" checkmarks on imported items. An item is "done"
    // for an assistant when there's a row here with their name. Lets the
    // /assist UI render checkboxes + gray out completed brand cards on a
    // per-assistant basis.
    name: "006_assist_completions",
    sql: `
      CREATE TABLE IF NOT EXISTS assist_completions (
        id BIGSERIAL PRIMARY KEY,
        store_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        assistant TEXT NOT NULL,
        completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (store_id, item_id, assistant)
      );
      CREATE INDEX IF NOT EXISTS idx_assist_completions_lookup
        ON assist_completions (store_id, assistant);
    `,
  },
  {
    // Tracks which admin (Austin / Michael) created each store. Drives the
    // dashboard's Mine/All filter and shows up alongside notes for
    // attribution. Nullable for stores that pre-date this column.
    name: "007_stores_created_by",
    sql: `
      ALTER TABLE stores
        ADD COLUMN IF NOT EXISTS created_by TEXT;
    `,
  },
  {
    // Per-user ordering of brand cards on the /assist picker. One row per
    // (user_name, store_id); `position` is a 0-based index. Each user
    // (Dennis, Toby, …) gets their own ordering, persisted across devices.
    //
    // Stores not present in the table for a given user fall back to the
    // server's default sort (last_imported_at DESC). When the UI saves a
    // new order, the server replaces all rows for that user in one
    // transaction — simpler than recomputing diffs and forces consistency.
    name: "008_card_priority",
    sql: `
      CREATE TABLE IF NOT EXISTS card_priority (
        user_name TEXT NOT NULL,
        store_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_name, store_id)
      );
      CREATE INDEX IF NOT EXISTS idx_card_priority_user
        ON card_priority (user_name, position);
    `,
  },
  {
    // Locks each admin slot (Austin, Michael) to the first browser that
    // claims it via the identity modal. `claim_token` is a long random
    // value mirrored into an HttpOnly admin_claim cookie; subsequent
    // requests prove identity by presenting the matching token.
    //
    // Threat model: anyone with the obscure admin URL can request the
    // SPA. The claim layer ensures the *identity* (Austin/Michael) is
    // bound to a specific browser. Once both slots are claimed, no
    // further visitors can authenticate as either user.
    //
    // To reset a claim (e.g., cookie lost on a new device), delete the
    // row from psql. We deliberately don't expose a "reset" API.
    name: "009_admin_claims",
    sql: `
      CREATE TABLE IF NOT EXISTS admin_claims (
        user_name TEXT PRIMARY KEY,
        claim_token TEXT NOT NULL,
        claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    // Reviewers: external (non-Redo, non-Replit) people who get access via
    // a per-reviewer URL token on the public-facing review deploy
    // (MIME_SURFACE=public_review). The token in the URL exchanges for a
    // reviewer_token HttpOnly cookie. Admin mints these rows (psql or a
    // small admin endpoint later). disabled_at revokes without deleting
    // the row (so old jobs still attribute to a name).
    name: "010_reviewers",
    sql: `
      CREATE TABLE IF NOT EXISTS reviewers (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        token       TEXT NOT NULL UNIQUE,
        email       TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        disabled_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_reviewers_token
        ON reviewers (token);
    `,
  },
  {
    // Tag stores with the reviewer who created them so reviewers see only
    // their own stores and admin sees everything (with a badge). Nullable
    // — existing stores stay unscoped, behavior unchanged on the admin
    // deploy. Partial index keeps the index small on production where
    // most stores are admin-created.
    name: "011_stores_reviewer",
    sql: `
      ALTER TABLE stores
        ADD COLUMN IF NOT EXISTS created_by_reviewer TEXT
          REFERENCES reviewers(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_stores_created_by_reviewer
        ON stores(created_by_reviewer)
        WHERE created_by_reviewer IS NOT NULL;
    `,
  },
];

/**
 * Run pending migrations once per process. Safe to call multiple times —
 * all migrations are idempotent (CREATE TABLE IF NOT EXISTS). Exits
 * silently if the DB isn't configured.
 */
export async function runMigrations(): Promise<void> {
  if (migrationsRun) return;
  if (!isDbEnabled()) return;
  const p = getPool();
  // We don't track applied migrations in a table yet — the IF NOT EXISTS
  // idempotency is enough for V1. When we start doing destructive
  // migrations (ALTER, etc.), introduce a schema_migrations table.
  for (const m of MIGRATIONS) {
    try {
      await p.query(m.sql);
    } catch (e) {
      console.error(`[db] migration ${m.name} failed:`, e);
      throw e;
    }
  }
  migrationsRun = true;
  console.log(`[db] migrations complete (${MIGRATIONS.length} ran)`);
}

/**
 * On process start, reset any jobs that look stuck from a prior replica.
 * Autoscale deploys don't guarantee that the replica which started a job
 * still exists after a scale-down — any job stuck in `running` /
 * `awaiting_input` when we boot is orphaned and should be failed.
 */
export async function reapStuckJobs(): Promise<number> {
  if (!isDbEnabled()) return 0;
  const p = getPool();
  try {
    const res = await p.query(
      `UPDATE jobs
         SET status = 'failed',
             error = COALESCE(error, 'server restart — job orphaned'),
             completed_at = NOW()
       WHERE status IN ('queued', 'running', 'awaiting_input')
       RETURNING id`,
    );
    if (res.rowCount && res.rowCount > 0) {
      console.log(`[db] reaped ${res.rowCount} orphaned job(s)`);
    }
    return res.rowCount ?? 0;
  } catch (e) {
    console.error("[db] reapStuckJobs failed:", e);
    return 0;
  }
}

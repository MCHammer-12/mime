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

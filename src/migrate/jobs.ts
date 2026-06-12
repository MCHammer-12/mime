/**
 * Job registry for the multi-store migration dashboard.
 *
 * A job is one "Import" click — potentially migrating multiple templates +
 * flows for a single store. Multiple jobs can run concurrently across
 * different stores.
 *
 * Persistence model:
 *   - In-memory Map is the hot source for streaming + subscribers.
 *   - Postgres (via `./db`) is the durable log; all mutations dual-write.
 *     If DATABASE_URL is unset the DB writes no-op and we fall back to
 *     memory-only (dev mode).
 *   - On startup, `hydrateFromDb()` loads recent jobs back into memory so
 *     the dashboard list endpoint sees yesterday's runs after a redeploy.
 *
 * needs_input pauses a job via an awaitable promise resolved by
 * `POST /api/jobs/:id/inputs`. Those promises are in-memory only (can't
 * cross replicas); Replit autoscale is configured single-instance for V1.
 */

import { randomUUID } from "node:crypto";
import { getPool, isDbEnabled } from "./db.js";
import { recordImportedItem, type ItemType } from "./imported-items.js";

export type Severity = "info" | "warn" | "error" | "success";

export type JobStatus =
  | "queued"
  | "running"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobEvent {
  /** Monotonic within a job, starting at 1. Used for `?since=N` polling. */
  seq: number;
  /** ISO timestamp server-side. */
  at: string;
  /** Event kind — matches the existing NDJSON event taxonomy. */
  kind: string;
  /** Display severity. If omitted, derived from kind. */
  severity: Severity;
  /** Kind-specific fields (label, error, id, name, etc.). */
  payload: Record<string, unknown>;
}

export interface PendingInputOption {
  value: string;
  label: string;
}

export interface PendingInput {
  /** Unique within the job; the client echoes this back to resolveInput. */
  id: string;
  /** Semantic key — same question across items uses the same key so the
   *  answer is reused automatically (ask once per unique key per job). */
  questionKey: string;
  /** Plain-English question shown to the user. */
  question: string;
  /** Additional clarifying context (what / why). */
  context?: string;
  /** Input type for the UI. */
  type: "text" | "choice" | "boolean";
  /** Required when type === "choice". */
  options?: PendingInputOption[];
  /** Suggested default the UI can prefill. */
  default?: string;
  /** The item the question is about (flow id, template id, etc.). */
  itemId?: string;
  /** Human-readable label for the item the question is about. */
  itemLabel?: string;
  /** When the question is uniquely keyed per item, suppress the
   *  "Apply to other items with the same question" checkbox in the UI —
   *  the cache reuse never fires anyway and showing it just misleads. */
  hideApplyAll?: boolean;
  /** For type:"boolean" — replace the default "Yes" / "No" button labels. */
  trueLabel?: string;
  falseLabel?: string;
}

export interface JobSummary {
  templatesImported: number;
  templatesFailed: number;
  flowsImported: number;
  flowsFailed: number;
  campaignsImported: number;
  campaignsFailed: number;
  /**
   * Total emails landed by this job — sum of templates + campaign variants
   * + emails inside imported flows. Drives the per-job toast "you just did
   * X Nigerian hours of duplication work" (X = ceil(emails * 20min / 60)).
   */
  emailsImported: number;
}

export interface JobState {
  id: string;
  /** Store identifier as known to Redo (aud claim). */
  storeId: string;
  /** User-friendly store name. */
  storeName: string;
  /** Internal slug / account directory under `migrations/`. */
  merchantSlug: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  /** Items originally requested (for rendering "2/5 done"). */
  templateIds: string[];
  flowIds: string[];
  /** Append-only event log. */
  events: JobEvent[];
  /** Currently-blocking input (only set when status === "awaiting_input"). */
  pendingInput?: PendingInput;
  /** Cache of resolved answers keyed by questionKey for same-job reuse. */
  answers: Record<string, string>;
  /** Populated on completion. */
  summary?: JobSummary;
  /** Fatal error (when status === "failed"). */
  error?: string;
  /** Free-text per-item troubleshooting notes, keyed by template/flow id. */
  notes: Record<string, string>;
}

interface PendingInputInternal {
  input: PendingInput;
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
}

// ─── Registry + pub/sub ────────────────────────────────────────────────────

const jobs = new Map<string, JobState>();
const waiters = new Map<string, PendingInputInternal>();

type JobHandler = (event: JobEvent) => void;
const listeners = new Map<string, Set<JobHandler>>();

function defaultSeverity(kind: string): Severity {
  switch (kind) {
    case "exported":
    case "imported":
    case "flow_imported":
    case "fonts_done":
    case "done":
      return "success";
    case "warn":
      return "warn";
    case "error":
    case "fail":
      return "error";
    default:
      return "info";
  }
}

export function createJob(params: {
  storeId: string;
  storeName: string;
  merchantSlug: string;
  templateIds: string[];
  flowIds: string[];
}): JobState {
  const id = randomUUID();
  const job: JobState = {
    id,
    storeId: params.storeId,
    storeName: params.storeName,
    merchantSlug: params.merchantSlug,
    status: "queued",
    createdAt: new Date().toISOString(),
    templateIds: params.templateIds,
    flowIds: params.flowIds,
    events: [],
    answers: {},
    notes: {},
  };
  jobs.set(id, job);
  // Fire-and-forget DB insert. If the DB is unavailable the row won't
  // persist past a restart, but the in-memory job still works for the
  // current session — no user-visible impact.
  if (isDbEnabled()) {
    getPool()
      .query(
        `INSERT INTO jobs (id, store_id, store_name, merchant_slug, status,
                           created_at, template_ids, flow_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [
          job.id,
          job.storeId,
          job.storeName,
          job.merchantSlug,
          job.status,
          job.createdAt,
          JSON.stringify(job.templateIds),
          JSON.stringify(job.flowIds),
        ],
      )
      .catch((e) => console.warn("[jobs] persist createJob failed:", e));
  }
  return job;
}

export function getJob(id: string): JobState | null {
  return jobs.get(id) ?? null;
}

/** List all jobs (optionally scoped to a store), newest first. */
export function listJobs(opts?: { storeId?: string }): JobState[] {
  const all = Array.from(jobs.values());
  const filtered = opts?.storeId
    ? all.filter((j) => j.storeId === opts.storeId)
    : all;
  return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Remove a job (e.g. after user dismisses completed jobs). */
export function deleteJob(id: string): boolean {
  const existing = jobs.get(id);
  if (!existing) return false;
  jobs.delete(id);
  listeners.delete(id);
  return true;
}

// ─── Event emission ─────────────────────────────────────────────────────────

export function appendEvent(
  jobId: string,
  event: { kind: string; severity?: Severity; [k: string]: unknown },
): JobEvent | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  const { kind, severity, ...payload } = event;
  const e: JobEvent = {
    seq: job.events.length + 1,
    at: new Date().toISOString(),
    kind,
    severity: severity ?? defaultSeverity(kind),
    payload,
  };
  job.events.push(e);
  const set = listeners.get(jobId);
  if (set) for (const h of set) h(e);
  // Dual-write to DB. Fire-and-forget; live streams still see the event
  // immediately via the in-memory pub/sub above.
  if (isDbEnabled()) {
    getPool()
      .query(
        `INSERT INTO job_events (job_id, seq, at, kind, severity, payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (job_id, seq) DO NOTHING`,
        [jobId, e.seq, e.at, e.kind, e.severity, JSON.stringify(e.payload)],
      )
      .catch((err) => console.warn("[jobs] persist event failed:", err));
  }
  return e;
}

export function setStatus(
  jobId: string,
  status: JobStatus,
  extras?: { summary?: JobSummary; error?: string },
): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = status;
  if (status === "running" && !job.startedAt) job.startedAt = new Date().toISOString();
  if (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled"
  ) {
    job.completedAt = new Date().toISOString();
  }
  if (extras?.summary) job.summary = extras.summary;
  if (extras?.error) job.error = extras.error;
  if (isDbEnabled()) {
    getPool()
      .query(
        `UPDATE jobs
           SET status = $2,
               started_at = COALESCE(started_at, $3),
               completed_at = $4,
               summary = $5::jsonb,
               error = $6
         WHERE id = $1`,
        [
          jobId,
          job.status,
          job.startedAt ?? null,
          job.completedAt ?? null,
          job.summary ? JSON.stringify(job.summary) : null,
          job.error ?? null,
        ],
      )
      .catch((err) => console.warn("[jobs] persist setStatus failed:", err));
  }
}

// ─── Notes (troubleshooting annotations) ───────────────────────────────────

/**
 * Stored note shape. Legacy entries are bare strings (admin-side notes
 * written before the assist view shipped); newer entries are objects with
 * an optional author so the assist UI can attribute notes. All readers
 * should funnel through `coerceNote` rather than touching the raw value.
 *
 * `resolvedAt` (ISO timestamp) marks a note as addressed — Michael's
 * workflow is: assistants leave feedback → he exports + ships a fix →
 * marks the note resolved so it drops out of the "Has feedback" tally
 * but the text stays for history.
 */
export type StoredNote =
  | string
  | { text: string; author?: string; savedAt: string; resolvedAt?: string; resolvedBy?: string };

export interface CoercedNote {
  text: string;
  author: string | null;
  savedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

/** Normalize whatever's in `jobs.notes[itemId]` into a uniform shape. */
export function coerceNote(value: unknown): CoercedNote | null {
  if (typeof value === "string") {
    return value.length > 0
      ? { text: value, author: null, savedAt: null, resolvedAt: null, resolvedBy: null }
      : null;
  }
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.text === "string" && v.text.length > 0) {
      return {
        text: v.text,
        author: typeof v.author === "string" ? v.author : null,
        savedAt: typeof v.savedAt === "string" ? v.savedAt : null,
        resolvedAt: typeof v.resolvedAt === "string" ? v.resolvedAt : null,
        resolvedBy: typeof v.resolvedBy === "string" ? v.resolvedBy : null,
      };
    }
  }
  return null;
}

/**
 * Upsert a note for a specific template or flow within a job. Empty text
 * clears the note. When `author` is provided the stored value is the
 * structured shape; when omitted it remains a bare string for compatibility
 * with existing admin-side callers and the Toby panel's local cache.
 *
 * Text edits IMPLICITLY REOPEN a previously-resolved note (drops the
 * resolvedAt/resolvedBy fields). The reasoning: if there's new text to
 * read, the prior resolution is stale — the assistant has come back with
 * additional context that needs Michael's attention again.
 */
export function setNote(
  jobId: string,
  itemId: string,
  note: string,
  author?: string,
): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  if (note.trim() === "") {
    delete job.notes[itemId];
  } else if (author && author.trim() !== "") {
    job.notes[itemId] = {
      text: note,
      author: author.trim(),
      savedAt: new Date().toISOString(),
    } as unknown as string;
    // ^ JobState.notes is typed Record<string,string> for legacy reasons;
    //   the JSONB column accepts the structured shape directly. Coerce
    //   readers via `coerceNote` rather than tightening the type until the
    //   structured shape is the only one in flight.
  } else {
    job.notes[itemId] = note;
  }
  if (isDbEnabled()) {
    getPool()
      .query(`UPDATE jobs SET notes = $2::jsonb WHERE id = $1`, [
        jobId,
        JSON.stringify(job.notes),
      ])
      .catch((err) => console.warn("[jobs] persist setNote failed:", err));
  }
  return true;
}

/**
 * Refresh a single job's notes column from Postgres into the in-memory
 * cache. Mime runs as multiple processes (admin Repl + public-review
 * Repl) sharing one Postgres; notes written by one process aren't
 * visible to the other until that process re-reads. Called from the
 * admin's job-detail + bundle endpoints so reviewer-side notes show
 * up without a full restart.
 *
 * Best-effort: swallows DB errors (caller still serves the stale
 * in-memory notes) and is a no-op when DB is disabled.
 */
export async function refreshJobNotesFromDb(jobId: string): Promise<void> {
  if (!isDbEnabled()) return;
  const job = jobs.get(jobId);
  if (!job) return;
  try {
    const r = await getPool().query(
      `SELECT notes FROM jobs WHERE id = $1`,
      [jobId],
    );
    const fresh = r.rows[0]?.notes;
    if (fresh && typeof fresh === "object") {
      job.notes = fresh as Record<string, string>;
    }
  } catch (err) {
    console.warn("[jobs] refreshJobNotesFromDb failed:", err);
  }
}

/**
 * Flip a note's resolved state without touching its text. Sets resolvedAt
 * to now (with the resolver's name) when `resolved` is true; drops both
 * fields when false. No-op if the item has no note.
 *
 * Preserves the existing text + author + savedAt so reopening doesn't lose
 * the assistant's original attribution. Plain-string notes get migrated
 * to the structured shape so we have somewhere to hang resolvedAt.
 */
export function setNoteResolved(
  jobId: string,
  itemId: string,
  resolved: boolean,
  resolver?: string,
): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  const raw = job.notes[itemId];
  const coerced = coerceNote(raw);
  if (!coerced) return false; // no note to resolve
  const next: Record<string, string> = { text: coerced.text };
  if (coerced.author) next.author = coerced.author;
  next.savedAt = coerced.savedAt ?? new Date().toISOString();
  if (resolved) {
    next.resolvedAt = new Date().toISOString();
    if (resolver && resolver.trim()) next.resolvedBy = resolver.trim();
  }
  job.notes[itemId] = next as unknown as string;
  if (isDbEnabled()) {
    getPool()
      .query(`UPDATE jobs SET notes = $2::jsonb WHERE id = $1`, [
        jobId,
        JSON.stringify(job.notes),
      ])
      .catch((err) => console.warn("[jobs] persist setNoteResolved failed:", err));
  }
  return true;
}

// ─── Subscription (for streaming endpoints) ────────────────────────────────

export function subscribe(jobId: string, handler: JobHandler): () => void {
  let set = listeners.get(jobId);
  if (!set) {
    set = new Set();
    listeners.set(jobId, set);
  }
  set.add(handler);
  return () => {
    set!.delete(handler);
    if (set!.size === 0) listeners.delete(jobId);
  };
}

// ─── User-input awaiter ─────────────────────────────────────────────────────

/**
 * Pause the job until the user answers `input.question`. Emits a
 * `needs_input` event, sets status to `awaiting_input`, and returns a
 * promise that resolves when `resolveInput` is called with the matching
 * input id.
 *
 * If the same questionKey has already been answered in this job, returns
 * the cached answer immediately without prompting (so "apply to all" works
 * naturally for repeated questions).
 */
export function awaitInput(
  jobId: string,
  input: Omit<PendingInput, "id">,
): Promise<string> {
  const job = jobs.get(jobId);
  if (!job) return Promise.reject(new Error(`job ${jobId} not found`));

  // Reuse prior answer to same question in this job.
  if (job.answers[input.questionKey] !== undefined) {
    return Promise.resolve(job.answers[input.questionKey]);
  }

  const fullInput: PendingInput = { ...input, id: randomUUID() };

  return new Promise<string>((resolve, reject) => {
    waiters.set(jobId, {
      input: fullInput,
      resolve: (answer: string) => {
        job.answers[input.questionKey] = answer;
        job.pendingInput = undefined;
        job.status = "running";
        resolve(answer);
      },
      reject,
    });
    job.pendingInput = fullInput;
    job.status = "awaiting_input";
    appendEvent(jobId, {
      kind: "needs_input",
      severity: "info",
      input: fullInput,
    });
  });
}

/** Client submits the answer via `POST /api/jobs/:id/inputs`. */
export function resolveInput(
  jobId: string,
  inputId: string,
  answer: string,
): { ok: true } | { ok: false; error: string } {
  const w = waiters.get(jobId);
  if (!w) return { ok: false, error: "no pending input" };
  if (w.input.id !== inputId) return { ok: false, error: "input id mismatch" };
  waiters.delete(jobId);
  w.resolve(answer);
  return { ok: true };
}

/** Abandon the pending input (e.g. on job cancel). */
export function rejectInput(jobId: string, reason: string): void {
  const w = waiters.get(jobId);
  if (!w) return;
  waiters.delete(jobId);
  w.reject(new Error(reason));
}

// ─── Startup hydration ─────────────────────────────────────────────────────

/**
 * Load recent jobs from Postgres into the in-memory cache so the
 * dashboard reflects prior-session history after a redeploy. Called once
 * from server.ts at startup.
 *
 * We load the last 200 jobs (by created_at desc) and their events. On a
 * busy day this might leave older jobs in the DB but unloaded from memory
 * — GET /api/jobs/:id still works because we fall back to a DB read in
 * getJob() (see below).
 */
export async function hydrateFromDb(limit = 200): Promise<number> {
  if (!isDbEnabled()) return 0;
  const pool = getPool();
  try {
    const { rows: jobRows } = await pool.query(
      `SELECT id, store_id, store_name, merchant_slug, status,
              created_at, started_at, completed_at, template_ids, flow_ids,
              summary, error, notes
         FROM jobs
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit],
    );
    if (jobRows.length === 0) return 0;

    const { rows: eventRows } = await pool.query(
      `SELECT job_id, seq, at, kind, severity, payload
         FROM job_events
        WHERE job_id = ANY($1)
        ORDER BY job_id, seq`,
      [jobRows.map((r) => r.id)],
    );
    const eventsByJob = new Map<string, JobEvent[]>();
    for (const r of eventRows) {
      const list = eventsByJob.get(r.job_id) ?? [];
      list.push({
        seq: r.seq,
        at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
        kind: r.kind,
        severity: r.severity as Severity,
        payload: r.payload ?? {},
      });
      eventsByJob.set(r.job_id, list);
    }

    for (const r of jobRows) {
      const job: JobState = {
        id: r.id,
        storeId: r.store_id,
        storeName: r.store_name,
        merchantSlug: r.merchant_slug,
        status: r.status as JobStatus,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        startedAt: r.started_at ? (r.started_at instanceof Date ? r.started_at.toISOString() : r.started_at) : undefined,
        completedAt: r.completed_at ? (r.completed_at instanceof Date ? r.completed_at.toISOString() : r.completed_at) : undefined,
        templateIds: Array.isArray(r.template_ids) ? r.template_ids : [],
        flowIds: Array.isArray(r.flow_ids) ? r.flow_ids : [],
        events: eventsByJob.get(r.id) ?? [],
        answers: {},
        summary: r.summary ?? undefined,
        error: r.error ?? undefined,
        notes: r.notes && typeof r.notes === "object" ? r.notes : {},
      };
      jobs.set(job.id, job);
    }
    return jobRows.length;
  } catch (e) {
    console.warn("[jobs] hydrateFromDb failed:", e);
    return 0;
  }
}

// ─── Convenience: the controller interface callers use ─────────────────────

/**
 * Passed into `runImport()` so the pipeline can emit events + prompt the
 * user without knowing about the job model directly. When running against
 * the legacy `/api/run` (which streams to res), a different controller
 * implementation can be supplied.
 */
export interface RunController {
  emit(event: { kind: string; severity?: Severity; [k: string]: unknown }): void;
  prompt(input: Omit<PendingInput, "id">): Promise<string>;
  /**
   * Record an item that successfully landed in Redo. Surfaces it in the
   * assist view's per-store item list and contributes to the "Hours saved"
   * tally. Best-effort — silently no-ops if the job no longer exists or
   * the DB is unavailable. `emailCount` defaults to 1 (single email);
   * pass the flow's createdTemplateCount + blankTemplateCount for flows.
   */
  recordImported(item: {
    itemId: string;
    itemType: ItemType;
    name: string;
    emailCount?: number;
  }): void;
}

export function jobController(jobId: string): RunController {
  return {
    emit(event) {
      appendEvent(jobId, event);
    },
    prompt(input) {
      return awaitInput(jobId, input);
    },
    recordImported(item) {
      const job = jobs.get(jobId);
      if (!job) return;
      recordImportedItem({
        storeId: job.storeId,
        storeName: job.storeName,
        jobId,
        itemId: item.itemId,
        itemType: item.itemType,
        name: item.name,
        emailCount: item.emailCount,
      });
    },
  };
}

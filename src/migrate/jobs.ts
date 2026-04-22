/**
 * In-memory job registry for the multi-store migration dashboard.
 *
 * A job is one "Import" click — potentially migrating multiple templates +
 * flows for a single store. Multiple jobs can run concurrently across
 * different stores (and even same-store, though the UI typically queues
 * those).
 *
 * Events are append-only per job and streamed to connected listeners.
 * `needs_input` events pause the job until the caller resolves them via
 * `resolveInput()` — typically from a `POST /api/jobs/:id/inputs` handler.
 *
 * Persistence: in-memory only. Process restart = lost jobs. Good enough for
 * V1 since the whole migration is re-runnable (we'll add klaviyoSourceId
 * dedup on the redoapp side to make that safe).
 */

import { randomUUID } from "node:crypto";

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
}

export interface JobSummary {
  templatesImported: number;
  templatesFailed: number;
  flowsImported: number;
  flowsFailed: number;
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
  };
  jobs.set(id, job);
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
}

export function jobController(jobId: string): RunController {
  return {
    emit(event) {
      appendEvent(jobId, event);
    },
    prompt(input) {
      return awaitInput(jobId, input);
    },
  };
}

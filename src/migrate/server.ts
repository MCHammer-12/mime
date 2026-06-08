/**
 * Local web UI for the Klaviyo → Redo migration pipeline.
 *
 * Usage:
 *   npx tsx src/migrate/server.ts [PORT]
 *
 * Then open http://localhost:PORT (default 8765) in your browser.
 *
 * Endpoints:
 *   GET  /                    HTML UI
 *   POST /api/templates       list Klaviyo templates (input: { klaviyoKey })
 *   POST /api/run             fetch + export + import (streams NDJSON progress)
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportTemplate } from "../export-template.js";
import { fetchAccount } from "../fetch-account.js";
import { parseFlow } from "../flow/parser.js";
import {
  findOptionByValue,
  MARKETING_TRIGGER_OPTIONS,
} from "../flow/marketing-trigger-options.js";
import { createTemplateResolver } from "../flow/template-resolver.js";
import type { KlaviyoFlow } from "../flow/types.js";
import { klaviyo, paginate, slug } from "../klaviyo.js";
import { fetchAllMetrics } from "../extract-metrics.js";
import type { ImportProgressEvent } from "./import-rpc.js";
import {
  decodeJwtAud,
  filterFontsNotInBrandKit,
  importFlowRpc,
  importTemplateRpc,
  RedoAuthExpiredError,
  uploadFontsForTemplates,
} from "./import-rpc.js";
import { disableDb, isDbEnabled, reapStuckJobs, runMigrations } from "./db.js";
import {
  createJob,
  deleteJob,
  getJob,
  hydrateFromDb,
  jobController,
  listJobs,
  refreshJobNotesFromDb,
  resolveInput,
  setNote,
  setNoteResolved,
  setStatus,
  subscribe,
  type JobSummary,
  type PendingInput,
  type RunController,
  type Severity,
} from "./jobs.js";
import { streamBundle, type BundleItemRequest } from "./bundle.js";
import {
  createStore,
  deleteStore,
  deleteStoreForReviewer,
  getStoreById,
  getStoreBySlug,
  getStoreForReviewer,
  listStores,
  listStoresForReviewer,
  toSummary,
  updateStore,
} from "./stores.js";
import {
  adminPathPrefix,
  clearAdminClaimCookie,
  clearAdminUserCookie,
  getAdminClaimToken,
  getAdminUser,
  isAdmin,
  isAdminAuthEnabled,
  isAdminEntryUrl,
  isAllowedAdminUser,
  requireAdmin,
  setAdminClaimCookie,
  setAdminCookie,
  setAdminUserCookie,
} from "./auth.js";
import {
  getClaimStatus,
  tryClaim,
  userForClaimToken,
} from "./claims.js";
import {
  emailsToHours,
  findLatestJobForItem,
  getCardOrder,
  getTotalEmailsImported,
  listAssistItemsForStore,
  listAssistStores,
  setAssistDone,
  setCardOrder,
} from "./imported-items.js";
import { getReviewerByToken, type ReviewerRecord } from "./reviewers.js";

const MIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../");
const DEFAULT_REDOAPP_DIR = join(homedir(), "code/redoapp");
const PORT = parseInt(process.env.PORT ?? process.argv[2] ?? "8765", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

// Detect Replit/managed deploy environments where bazel-backed import isn't available.
const IS_HOSTED_DEPLOY = Boolean(
  process.env.REPL_ID || process.env.REPLIT_DEPLOYMENT || process.env.HOSTED_DEPLOY,
);

// Detect whether AI credentials are available from env (Replit AI Integrations
// injects AI_INTEGRATIONS_ANTHROPIC_*, local dev sets ANTHROPIC_API_KEY). When
// true the UI can hide its Anthropic-key field and AI rewrites are enabled by
// default without the user pasting anything.
const AI_AVAILABLE = Boolean(
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY,
);

// Surface mode — which deployment is this process running as?
//   "admin"          → existing internal deployment (Toby 2.0, import wizard,
//                      assist surface). Default; matches pre-2026-05-26 behavior.
//   "public_review"  → external reviewer deployment. Only /r/<token>/, /dashboard,
//                      and /api/r/* routes are reachable; admin/assist/import
//                      endpoints 404. Same repo + Postgres, different Replit
//                      Autoscale deployment with MIME_SURFACE=public_review.
//
// The split exists because external reviewers (non-Redo employees) can't be
// added to the Replit workspace and so can't reach the private deploy at all.
// See plans/2026-05-26-reviewer-dashboard.md for the full architecture.
type MimeSurface = "admin" | "public_review";
const MIME_SURFACE: MimeSurface =
  process.env.MIME_SURFACE === "public_review" ? "public_review" : "admin";

// Optional HTTP Basic auth. Gated on BASIC_AUTH_USER + BASIC_AUTH_PASS env vars;
// if either is unset, auth is skipped entirely (local dev).
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER ?? "";
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS ?? "";
const BASIC_AUTH_ENABLED = BASIC_AUTH_USER !== "" && BASIC_AUTH_PASS !== "";

function checkBasicAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!BASIC_AUTH_ENABLED) return true;
  const header = req.headers["authorization"] ?? "";
  const match = /^Basic (.+)$/.exec(String(header));
  if (match) {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx !== -1) {
      const user = decoded.slice(0, idx);
      const pass = decoded.slice(idx + 1);
      if (user === BASIC_AUTH_USER && pass === BASIC_AUTH_PASS) return true;
    }
  }
  res.writeHead(401, {
    "www-authenticate": 'Basic realm="mime"',
    "content-type": "text/plain",
  });
  res.end("Authentication required");
  return false;
}

// ─── helpers ───────────────────────────────────────────────────────────────

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function ndjsonStart(res: ServerResponse) {
  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  });
}

function emit(res: ServerResponse, event: Record<string, unknown>) {
  res.write(JSON.stringify(event) + "\n");
}

/**
 * Build a RunController bound to a ServerResponse (streaming path). Used by
 * the legacy `POST /api/run` endpoint. `prompt()` is a no-op in this path —
 * returns the default immediately, since NDJSON streams can't round-trip
 * user input. The job-based path gets a real `prompt()` via jobController().
 */
function resController(res: ServerResponse, job?: { id: string }): RunController {
  return {
    emit(event) {
      res.write(JSON.stringify(event) + "\n");
      // Also fan out to the job log so /api/jobs/:id/stream sees the same
      // events if the caller also created a job. Legacy /api/run doesn't
      // create a job, so `job` is undefined and this is a no-op there.
      if (job) jobController(job.id).emit(event);
    },
    async prompt(input) {
      // Legacy stream can't prompt — fall back to default (if any) or
      // return an empty string so callers can degrade gracefully.
      return input.default ?? "";
    },
    recordImported(item) {
      // Forward to the job-backed controller when this stream also
      // created a job; otherwise the legacy /api/run path silently drops
      // the row (it never appeared in the dashboard anyway).
      if (job) jobController(job.id).recordImported(item);
    },
  };
}

// ─── API: /api/templates ───────────────────────────────────────────────────

async function handleTemplates(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody(req);
  const key = body.klaviyoKey as string;
  if (!key) return json(res, 400, { error: "klaviyoKey required" });

  try {
    type T = {
      id: string;
      attributes: { name: string; editor_type: string; updated: string };
    };
    const all = await paginate<T>(
      "/templates/?fields[template]=name,editor_type,updated&sort=-updated",
      key,
    );
    const templates = all
      .filter((t) => t.attributes.editor_type !== "KLAVIYO")
      .map((t) => ({
        id: t.id,
        name: t.attributes.name,
        editorType: t.attributes.editor_type,
        updated: t.attributes.updated,
      }));

    let accountName: string | null = null;
    try {
      const acct = await fetchAccount(key);
      accountName = acct.organizationName;
    } catch (e) {
      // non-fatal
    }

    json(res, 200, { templates, accountName });
  } catch (e: any) {
    json(res, 500, { error: e.message ?? String(e) });
  }
}

// ─── API: /api/flows ───────────────────────────────────────────────────────
//
// Flow emails in Klaviyo live inside flow-action/flow-message relationships,
// not (reliably) in the user-facing /templates list. We walk the flow tree
// so the UI can show "Flow name → Email 1, Email 2, …" and the user can
// pick by flow email rather than scroll a flat 400-entry template list.

// Walker shared by /api/flows (single JSON response) and
// /api/flows/stream (NDJSON progress + terminal payload). Extracted so
// both endpoints stay in lockstep — the streaming endpoint is purely a
// presentation wrapper around the same logic.
//
// `onProgress` receives:
//   - { kind: "discovered", total }  — once, after the flow list is paginated
//   - { kind: "scanned", scanned, total, currentName, emailsForFlow }
//                                    — once per flow, in completion order
//
// Both events are best-effort; the walker never fails because of progress.
type FlowWalkProgress =
  | { kind: "discovered"; total: number }
  | { kind: "scanned"; scanned: number; total: number; currentName: string; emailsForFlow: number };

type FlowMeta = {
  id: string;
  attributes: { name: string; status: string; trigger_type: string };
};

type WalkedFlow = {
  flowId: string;
  flowName: string;
  flowStatus: string;
  triggerType: string;
  emails: Array<{
    templateId: string | null;
    messageId: string;
    actionId: string;
    name: string | null;
  }>;
};

type WalkDebug = {
  totalFlows: number;
  flowsWithActions: number;
  flowsWithNoActions: number;
  actionTypeCounts: Record<string, number>;
  messagesSeen: number;
  messagesWithTemplate: number;
  messagesWithoutTemplate: number;
  failedActionFetches: number;
  failedMessageFetches: number;
  sampleFlowNames: string[];
  sampleMessageFetchErrors: string[];
};

function emptyWalkDebug(totalFlows = 0): WalkDebug {
  return {
    totalFlows,
    flowsWithActions: 0,
    flowsWithNoActions: 0,
    actionTypeCounts: {},
    messagesSeen: 0,
    messagesWithTemplate: 0,
    messagesWithoutTemplate: 0,
    failedActionFetches: 0,
    failedMessageFetches: 0,
    sampleFlowNames: [],
    sampleMessageFetchErrors: [],
  };
}

// Walk one flow via the embedded `definition` field. One Klaviyo call per
// flow (vs. the prior 6–11 per flow that walked actions + per-action
// messages + per-message template relationships) — same payload the import
// path consumes, so `data.message.template_id` / `name` are inline.
//
// Always returns a walked row — flows with no email actions or a
// transient fetch failure surface as `emails: []` so the user sees them
// in the selection UI and can attempt import.
async function walkOneFlow(
  f: FlowMeta,
  key: string,
  debug: WalkDebug,
): Promise<{ walked: WalkedFlow; emailsForFlow: number }> {
  if (debug.sampleFlowNames.length < 10) {
    debug.sampleFlowNames.push(f.attributes.name);
  }
  const empty = (): WalkedFlow => ({
    flowId: f.id,
    flowName: f.attributes.name,
    flowStatus: f.attributes.status,
    triggerType: f.attributes.trigger_type,
    emails: [],
  });
  try {
    const flowResp: any = await klaviyo(
      `/flows/${f.id}/?additional-fields%5Bflow%5D=definition`,
      key,
    );
    const actions = flowResp?.data?.attributes?.definition?.actions ?? [];
    if (actions.length > 0) debug.flowsWithActions++;
    else debug.flowsWithNoActions++;

    const emails: WalkedFlow["emails"] = [];
    for (const a of actions) {
      const type = (a.type ?? "").toLowerCase();
      debug.actionTypeCounts[type] = (debug.actionTypeCounts[type] ?? 0) + 1;
      if (type !== "send-email") continue;

      const msg = a.data?.message ?? {};
      const tplId: string | null = msg.template_id ?? null;
      debug.messagesSeen++;
      if (tplId) debug.messagesWithTemplate++;
      else debug.messagesWithoutTemplate++;
      emails.push({
        templateId: tplId,
        messageId: msg.id != null ? String(msg.id) : String(a.id),
        actionId: String(a.id),
        name: msg.name ?? msg.label ?? msg.subject_line ?? null,
      });
    }
    return {
      walked: { ...empty(), emails },
      emailsForFlow: emails.length,
    };
  } catch (e: any) {
    debug.failedActionFetches++;
    if (debug.sampleMessageFetchErrors.length < 6) {
      debug.sampleMessageFetchErrors.push(
        `definition: ${e?.message?.slice(0, 120) ?? String(e).slice(0, 120)}`,
      );
    }
    return { walked: empty(), emailsForFlow: 0 };
  }
}

async function walkFlowsFromKlaviyo(
  key: string,
  onProgress?: (ev: FlowWalkProgress) => void,
) {
  const flows = await paginate<FlowMeta>(
    "/flows/?fields[flow]=name,status,trigger_type&sort=-updated",
    key,
  );
  try { onProgress?.({ kind: "discovered", total: flows.length }); } catch {}

  // Run per-flow walks in parallel with bounded concurrency.
  const LIMIT = 8;
  const out: WalkedFlow[] = [];
  const debug = emptyWalkDebug(flows.length);

  let idx = 0;
  let scanned = 0;
  async function worker() {
    while (idx < flows.length) {
      const i = idx++;
      const f = flows[i]!;
      const { walked, emailsForFlow } = await walkOneFlow(f, key, debug);
      if (walked) out.push(walked);
      scanned++;
      try {
        onProgress?.({
          kind: "scanned",
          scanned,
          total: flows.length,
          currentName: f.attributes.name,
          emailsForFlow,
        });
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: LIMIT }, () => worker()));

  // Sort: live flows first, then by name
  out.sort((a, b) => {
    const rank = (s: string) =>
      s === "live" ? 0 : s === "manual" ? 1 : s === "draft" ? 2 : 3;
    return (
      rank(a.flowStatus) - rank(b.flowStatus) ||
      a.flowName.localeCompare(b.flowName)
    );
  });

  return { flows: out, debug };
}

// Sort comparator factored out so /api/flows/walk-batch consumers can
// reorder the assembled result the same way the streaming walker does.
function sortWalkedFlows(out: WalkedFlow[]) {
  out.sort((a, b) => {
    const rank = (s: string) =>
      s === "live" ? 0 : s === "manual" ? 1 : s === "draft" ? 2 : 3;
    return (
      rank(a.flowStatus) - rank(b.flowStatus) ||
      a.flowName.localeCompare(b.flowName)
    );
  });
}

async function handleFlows(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody(req);
  const key = body.klaviyoKey as string;
  if (!key) return json(res, 400, { error: "klaviyoKey required" });

  try {
    const result = await walkFlowsFromKlaviyo(key);
    json(res, 200, result);
  } catch (e: any) {
    json(res, 500, { error: e.message ?? String(e) });
  }
}

// Fast list-only endpoint — paginates flow metadata without walking
// per-flow actions/messages. Used by the client to enumerate the catalog
// quickly, then walk each flow in small batches via /api/flows/walk-batch.
// This lets a 70+ flow store load reliably even when the proxy/cloud-run
// imposes a hard per-request duration cap that would kill a single
// long-running stream.
async function handleFlowsList(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody(req);
  const key = body.klaviyoKey as string;
  if (!key) return json(res, 400, { error: "klaviyoKey required" });
  try {
    const flows = await paginate<FlowMeta>(
      "/flows/?fields[flow]=name,status,trigger_type&sort=-updated",
      key,
    );
    json(res, 200, {
      flows: flows.map((f) => ({
        id: f.id,
        name: f.attributes.name,
        status: f.attributes.status,
        triggerType: f.attributes.trigger_type,
      })),
    });
  } catch (e: any) {
    json(res, 500, { error: e.message ?? String(e) });
  }
}

// Walk a caller-supplied batch of flow IDs. Each request stays well
// under any proxy timeout because the client controls batch size
// (~10 flows per call ≈ 10–20 s). Returns walked rows plus a debug
// delta the client can merge to reconstruct the original walker's
// aggregate diagnostics.
async function handleFlowsWalkBatch(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody(req);
  const key = body.klaviyoKey as string;
  const flowsIn = body.flows as Array<{
    id: string;
    name?: string;
    status?: string;
    triggerType?: string;
  }> | undefined;
  if (!key) return json(res, 400, { error: "klaviyoKey required" });
  if (!Array.isArray(flowsIn) || flowsIn.length === 0) {
    return json(res, 400, { error: "flows[] required" });
  }
  // Hard cap to keep per-request wall time bounded even if a misbehaving
  // client asks for the world.
  if (flowsIn.length > 25) {
    return json(res, 400, { error: "batch too large (max 25)" });
  }

  const flowMetas: FlowMeta[] = flowsIn.map((f) => ({
    id: f.id,
    attributes: {
      name: f.name ?? "",
      status: f.status ?? "",
      trigger_type: f.triggerType ?? "",
    },
  }));
  const debug = emptyWalkDebug(flowMetas.length);
  const out: WalkedFlow[] = [];

  // Per-batch concurrency is intentionally lower than the legacy
  // walkFlowsFromKlaviyo()'s LIMIT=8 because the client runs multiple
  // batch requests in parallel — combined concurrency would otherwise
  // hit Klaviyo's per-endpoint burst limits and cause cascading 429s.
  // 4 here × 3 client batches ≈ 12 total walkers, comparable to the old
  // single-stream design.
  const LIMIT = 4;
  let idx = 0;
  async function worker() {
    while (idx < flowMetas.length) {
      const i = idx++;
      const f = flowMetas[i]!;
      const { walked } = await walkOneFlow(f, key, debug);
      if (walked) out.push(walked);
    }
  }
  try {
    await Promise.all(Array.from({ length: LIMIT }, () => worker()));
    json(res, 200, { walked: out, debug });
  } catch (e: any) {
    json(res, 500, { error: e.message ?? String(e) });
  }
}

// NDJSON streaming variant of /api/flows. Same payload as the JSON
// version, but interleaved with progress events so the UI can render a
// live "scanned 23 of 87 flows" bar instead of a featureless spinner.
//
// Wire format (one JSON object per line, terminated by \n):
//   {"kind":"discovered","total":87}
//   {"kind":"progress","scanned":1,"total":87,"currentName":"Welcome Series","emailsForFlow":3}
//   ... more progress lines ...
//   {"kind":"done","flows":[...],"debug":{...}}
//   — or on failure —
//   {"kind":"error","error":"..."}
async function handleFlowsStream(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody(req);
  const key = body.klaviyoKey as string;
  if (!key) return json(res, 400, { error: "klaviyoKey required" });

  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no", // disable proxy buffering so the client sees lines as they're written
  });

  const writeLine = (obj: unknown) => {
    try {
      res.write(JSON.stringify(obj) + "\n");
    } catch {
      // peer hung up — let the walker continue but stop trying to write
    }
  };

  // Emit an early ping so the client's first read resolves immediately,
  // proving the connection is live even before the slow Klaviyo calls
  // start coming back.
  writeLine({ kind: "started" });

  // Periodic heartbeat so the connection never goes idle. For stores
  // with many flows, the walker can stall briefly during 429 retry-after
  // back-offs (no progress events for several seconds) — long enough for
  // Replit's autoscale / cloud-run proxy to close the connection mid-walk.
  // The heartbeat keeps bytes flowing so the stream survives until the
  // terminal "done" event lands.
  const heartbeat = setInterval(() => {
    writeLine({ kind: "heartbeat", t: Date.now() });
  }, 10_000);

  try {
    const result = await walkFlowsFromKlaviyo(key, (ev) => {
      if (ev.kind === "discovered") {
        writeLine({ kind: "discovered", total: ev.total });
      } else {
        writeLine({
          kind: "progress",
          scanned: ev.scanned,
          total: ev.total,
          currentName: ev.currentName,
          emailsForFlow: ev.emailsForFlow,
        });
      }
    });
    writeLine({ kind: "done", flows: result.flows, debug: result.debug });
  } catch (e: any) {
    writeLine({ kind: "error", error: e?.message ?? String(e) });
  } finally {
    clearInterval(heartbeat);
    try { res.end(); } catch {}
  }
}

// ─── API: /api/campaigns ───────────────────────────────────────────────────
//
// Campaign emails in Klaviyo live as campaign → campaign-message → template.
// When the merchant built the campaign in Klaviyo's UI (never clicked
// "Save as template"), the underlying template is a non-reusable clone
// that does NOT appear in /templates/ listings. We walk campaigns → messages
// and pull each message's template relationship so the UI can offer
// campaigns as a third importable source alongside standalone templates +
// flow emails.

async function handleCampaigns(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody(req);
  const key = body.klaviyoKey as string;
  if (!key) return json(res, 400, { error: "klaviyoKey required" });

  try {
    type CampaignMeta = {
      id: string;
      attributes: {
        name: string;
        status: string;
        send_time?: string | null;
        created_at?: string | null;
      };
    };
    // filter=equals(messages.channel,"email") is Klaviyo's required filter
    // on the campaigns endpoint (they split email + sms campaigns). Use
    // double-quoted JSON-style strings to match Klaviyo's filter spec — same
    // form as the flow-messages call elsewhere in this file. Single-quoted
    // strings are rejected by some merchant accounts with a 400.
    //
    // We deliberately fetch only the 10 most-recent campaigns (single page,
    // no pagination). Walking every campaign + every campaign-message +
    // every template relationship for accounts with hundreds of historical
    // campaigns would routinely exceed the deploy proxy's 60s response
    // window and return a 504 Gateway Timeout. Most merchants only want
    // their recent campaigns migrated anyway; older ones can be added
    // later by lifting this cap.
    const filter = encodeURIComponent(`equals(messages.channel,"email")`);
    const campaignsBody: any = await klaviyo(
      `/campaigns/?filter=${filter}&fields[campaign]=name,status,send_time,created_at&sort=-created_at&page[size]=10`,
      key,
    );
    const campaigns: CampaignMeta[] = (campaignsBody?.data ?? []).slice(0, 10);

    type CampaignOut = {
      campaignId: string;
      campaignName: string;
      status: string;
      sendTime: string | null;
      createdAt: string | null;
      messages: Array<{
        messageId: string;
        templateId: string | null;
        label: string | null;
        subject: string | null;
      }>;
    };
    const out: CampaignOut[] = [];

    const debug = {
      totalCampaigns: campaigns.length,
      campaignsWithMessages: 0,
      campaignsWithNoMessages: 0,
      messagesSeen: 0,
      messagesWithTemplate: 0,
      messagesWithoutTemplate: 0,
      failedMessageFetches: 0,
      sampleCampaignNames: [] as string[],
      sampleFetchErrors: [] as string[],
      statusCounts: {} as Record<string, number>,
    };

    const LIMIT = 5;
    let idx = 0;
    async function worker() {
      while (idx < campaigns.length) {
        const i = idx++;
        const c = campaigns[i]!;
        const status = c.attributes.status ?? "unknown";
        debug.statusCounts[status] = (debug.statusCounts[status] ?? 0) + 1;
        if (debug.sampleCampaignNames.length < 10) {
          debug.sampleCampaignNames.push(c.attributes.name);
        }

        try {
          // Per-campaign: get its messages. Messages carry `label`
          // (A/B variant label — "Message A", "Message B") and a
          // template relationship (inline).
          const msgs: any = await klaviyo(
            `/campaigns/${c.id}/campaign-messages/`,
            key,
          );
          const msgData = msgs?.data ?? [];
          if (msgData.length === 0) {
            debug.campaignsWithNoMessages++;
            continue;
          }
          debug.campaignsWithMessages++;

          const messages: CampaignOut["messages"] = [];
          for (const m of msgData) {
            debug.messagesSeen++;
            // Try inline relationship first; fall back to the dedicated
            // relationships endpoint if needed (same pattern as flow-messages).
            let tplId: string | null =
              m.relationships?.template?.data?.id ?? null;
            if (!tplId) {
              try {
                const rel: any = await klaviyo(
                  `/campaign-messages/${m.id}/relationships/template/`,
                  key,
                );
                tplId = rel?.data?.id ?? null;
              } catch (e: any) {
                debug.failedMessageFetches++;
                if (debug.sampleFetchErrors.length < 3) {
                  debug.sampleFetchErrors.push(
                    `rel: ${e.message?.slice(0, 120) ?? String(e).slice(0, 120)}`,
                  );
                }
              }
            }
            if (tplId) debug.messagesWithTemplate++;
            else debug.messagesWithoutTemplate++;

            // Klaviyo names these fields inside `definition` on the message.
            const def = m.attributes?.definition ?? {};
            messages.push({
              messageId: m.id,
              templateId: tplId,
              label: m.attributes?.label ?? null,
              subject: def.content?.subject ?? null,
            });
          }

          out.push({
            campaignId: c.id,
            campaignName: c.attributes.name,
            status,
            sendTime: c.attributes.send_time ?? null,
            createdAt: c.attributes.created_at ?? null,
            messages,
          });
        } catch (e: any) {
          debug.failedMessageFetches++;
          if (debug.sampleFetchErrors.length < 3) {
            debug.sampleFetchErrors.push(
              `messages: ${e.message?.slice(0, 120) ?? String(e).slice(0, 120)}`,
            );
          }
        }
      }
    }
    await Promise.all(Array.from({ length: LIMIT }, () => worker()));

    // Already sorted by `-created_at` from the query; no need to re-sort.

    json(res, 200, { campaigns: out, debug });
  } catch (e: any) {
    json(res, 500, { error: e.message ?? String(e) });
  }
}

// ─── Run parameters + core pipeline ────────────────────────────────────────

interface RunParams {
  klaviyoKey: string;
  storeId: string;
  merchantSlug: string;
  templateIds: string[];
  flowIds: string[];
  campaignIds: string[];
  skipAi: boolean;
  anthropicKey?: string;
  redoJwt?: string;
  redoServerBase?: string;
  wantsImport: boolean;
  useRpcImport: boolean;
  useBazelImport: boolean;
  redoappDir: string;
}

function parseRunBody(body: any): RunParams | { error: string } {
  const klaviyoKey = body.klaviyoKey as string;
  const storeId = body.storeId as string;
  const merchantSlug = body.merchantSlug as string;
  const templateIds = (body.templateIds ?? []) as string[];
  const flowIds = (body.flowIds ?? []) as string[];
  const campaignIds = (body.campaignIds ?? []) as string[];
  if (
    !klaviyoKey ||
    !storeId ||
    !merchantSlug ||
    (templateIds.length === 0 && flowIds.length === 0 && campaignIds.length === 0)
  ) {
    return {
      error:
        "klaviyoKey, storeId, merchantSlug, and at least one of templateIds/flowIds/campaignIds required",
    };
  }
  const redoJwt = (body.redoJwt as string | undefined)?.trim() || undefined;
  const wantsImport = body.runImport !== false;
  return {
    klaviyoKey,
    storeId,
    merchantSlug,
    templateIds,
    flowIds,
    campaignIds,
    skipAi: body.skipAi !== false,
    anthropicKey: body.anthropicKey as string | undefined,
    redoJwt,
    redoServerBase: (body.redoServerBase as string | undefined)?.trim() || undefined,
    wantsImport,
    useRpcImport: wantsImport && !!redoJwt,
    useBazelImport: wantsImport && !redoJwt && !IS_HOSTED_DEPLOY,
    redoappDir:
      (body.redoappDir as string | undefined) ||
      process.env.REDOAPP_DIR ||
      DEFAULT_REDOAPP_DIR,
  };
}

/**
 * Full migration pipeline. All event output goes through `ctrl` (which can
 * be res-backed for legacy streaming OR job-backed for the async dashboard).
 * User-input prompts go through `ctrl.prompt()` — resolves to a default for
 * res-backed controllers, awaits a real answer for job-backed ones.
 */
async function runImport(
  params: RunParams,
  ctrl: RunController,
): Promise<JobSummary> {
  const {
    klaviyoKey,
    storeId,
    merchantSlug,
    templateIds,
    flowIds,
    campaignIds,
    skipAi,
    anthropicKey,
    redoJwt,
    redoServerBase: bodyRedoServerBase,
    wantsImport,
    useRpcImport,
    useBazelImport,
    redoappDir,
  } = params;
  const shouldImport = useRpcImport || useBazelImport;
  const summary: JobSummary = {
    templatesImported: 0,
    templatesFailed: 0,
    flowsImported: 0,
    flowsFailed: 0,
    campaignsImported: 0,
    campaignsFailed: 0,
    emailsImported: 0,
  };

  const emit = (event: { kind: string; severity?: Severity; [k: string]: unknown }) =>
    ctrl.emit(event);

  if (anthropicKey && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = anthropicKey;
  }

    // 1. Fetch account
    emit({ kind: "step", label: "Fetching Klaviyo account…" });
    let account: import("../fetch-account.js").KlaviyoAccount | null = null;
    try {
      account = await fetchAccount(klaviyoKey);
      emit({ kind: "info", text: `Account: ${account.organizationName}` });
    } catch (e: any) {
      emit({ kind: "warn", text: `Could not fetch account (${e.message}). Variable substitution skipped.` });
    }

    // 2. Prepare output dir
    const templatesDir = join(MIME_ROOT, "migrations", merchantSlug, "templates");
    mkdirSync(templatesDir, { recursive: true });
    emit({ kind: "info", text: `Output: ${templatesDir}` });

    // 3. Download + export each template
    const exported: { id: string; name: string; path: string }[] = [];
    const failures: { id: string; name: string; error: string }[] = [];

    for (const tid of templateIds) {
      emit({ kind: "step", label: `Downloading ${tid}…` });
      try {
        const full: any = await klaviyo(`/templates/${tid}/`, klaviyoKey);
        const name = full.data?.attributes?.name ?? tid;
        const html = full.data?.attributes?.html ?? "";
        if (!html) {
          failures.push({
            id: tid,
            name,
            error: "template has no HTML (editor_type may not be supported)",
          });
          emit({ kind: "fail", id: tid, name, error: "no HTML" });
          continue;
        }
        const base = `${tid}-${slug(name, tid)}`;
        const htmlPath = join(templatesDir, `${base}.html`);
        writeFileSync(htmlPath, html, "utf8");
        writeFileSync(
          join(templatesDir, `${base}.json`),
          JSON.stringify(full.data, null, 2),
          "utf8",
        );

        emit({ kind: "step", label: `Exporting ${name}…` });
        const result = await exportTemplate(htmlPath, { account, skipAi });

        exported.push({ id: tid, name, path: result.outPath });
        emit({
          kind: "exported",
          id: tid,
          name,
          sectionCount: result.sectionCount,
          warnings: result.warnings.length,
          unsupported: result.unsupportedFeatures.length,
          reviewItems: result.reviewItems.length,
          aiRewrites: result.aiRewrites,
          fontPlanEntries: result.fontPlan.entries.map((e: any) => ({
            family: e.family,
            available: e.resolution.available,
          })),
          // Full lists for the troubleshoot bundle. Counts above stay for the
          // existing UI surface (summary chips); the bundle endpoint uses the
          // full payload to write per-item parse-result.json files.
          warningList: result.warnings,
          unsupportedList: result.unsupportedFeatures,
          reviewItemList: result.reviewItems,
          skippedList: result.skippedBlocks,
          substitutions: result.substitutions,
          outputPath: result.outPath,
          // Snapshot Klaviyo source so the troubleshoot bundle can serve it
          // later even when migrations/<slug>/templates/ is empty (Replit's
          // filesystem is stateless across process restarts). bundle.ts reads
          // these as a fallback when the on-disk files are missing.
          klaviyoHtml: html,
          klaviyoMeta: full.data,
        });
      } catch (e: any) {
        const msg = e.message ?? String(e);
        failures.push({ id: tid, name: tid, error: msg });
        emit({ kind: "fail", id: tid, name: tid, error: msg });
      }
    }

    if (templateIds.length > 0) {
      emit({ kind: "summary", exported: exported.length, failed: failures.length });
    }

    const hasTemplatesToImport = exported.length > 0;
    const hasFlowsToImport = flowIds.length > 0;
    const hasCampaignsToImport = campaignIds.length > 0;

    if (
      !shouldImport ||
      (!hasTemplatesToImport && !hasFlowsToImport && !hasCampaignsToImport)
    ) {
      if (IS_HOSTED_DEPLOY && !redoJwt && wantsImport) {
        emit({ kind: "info", text: "Import skipped. Paste a Redo auth token to import via RPC." });
      }
      const cmd = `cd ${redoappDir} && bazel run //redo/manage:import-klaviyo-templates -- --team ${storeId} --account ${merchantSlug} --mime-dir ${MIME_ROOT}`;
      emit({ kind: "done", importSkipped: true, importCommand: cmd });
      return summary;
    }

    // Flow + campaign imports require RPC (merchant JWT); bazel path for
    // those isn't wired. If user requested them without a JWT, warn.
    if (hasFlowsToImport && !useRpcImport) {
      emit({
        kind: "warn",
        text: `Flow import requires a Redo auth token (JWT). Skipping ${flowIds.length} flow(s). Templates below will still import via bazel.`,
      });
    }
    if (hasCampaignsToImport && !useRpcImport) {
      emit({
        kind: "warn",
        text: `Campaign import requires a Redo auth token (JWT). Skipping ${campaignIds.length} campaign(s).`,
      });
    }

    // ─── Import via marketing-rpc + font upload (Replit + local) ──────
    if (useRpcImport) {
      const serverBase = bodyRedoServerBase;
      // Holder for the merchant JWT — mutable so a mid-import refresh
      // (see withFreshJwt below) propagates to subsequent calls in this
      // run without re-threading through every closure.
      let currentJwt = redoJwt!;
      // How many times we've prompted the user for a fresh token in this
      // job. Used to make each prompt's questionKey unique so awaitInput
      // doesn't auto-replay a stale (already-expired) answer from cache.
      let jwtRefreshCount = 0;

      /**
       * Run an RPC call. If Redo returns 401/403 (token expired), pause
       * the job, prompt the user for a fresh JWT, and retry — up to a
       * small attempt cap so a wrong token doesn't loop forever. The
       * refreshed token is reused by every subsequent RPC call in this
       * run (currentJwt is closed over).
       */
      async function withFreshJwt<T>(
        fn: (jwt: string) => Promise<T>,
        label: string,
      ): Promise<T> {
        const MAX_REFRESH_ATTEMPTS = 5;
        for (let attempt = 0; attempt <= MAX_REFRESH_ATTEMPTS; attempt++) {
          try {
            return await fn(currentJwt);
          } catch (e: any) {
            if (!(e instanceof RedoAuthExpiredError)) throw e;
            if (attempt === MAX_REFRESH_ATTEMPTS) {
              throw new Error(
                `Redo auth still failing after ${MAX_REFRESH_ATTEMPTS} token refreshes — giving up on ${label}`,
              );
            }
            emit({
              kind: "warn",
              text:
                attempt === 0
                  ? `Redo session token expired while ${label}. Paste a fresh token to continue.`
                  : `That token also failed (${e.status}). Paste another to continue ${label}.`,
            });
            const fresh = await ctrl.prompt({
              questionKey: `redo-jwt-refresh-${++jwtRefreshCount}`,
              question:
                "Your Redo session token has expired. Paste a fresh JWT to resume the import.",
              context:
                "Open redo.com in another tab and sign in. Then in DevTools → Application → Local Storage, copy the value of redo.merchant_auth_token.<teamId>. Or grab the Authorization header from any request to app-server.getredo.com.",
              type: "text",
              default: "",
              itemLabel: "Redo session token",
            });
            const trimmed = (fresh ?? "").trim();
            // The needs_input modal turns "Skip this item" into the
            // type's default ("" for text). Treat empty as abort —
            // there's nothing useful to retry with.
            if (!trimmed || trimmed === "__skip__") {
              throw new Error(
                `Redo token refresh skipped — cannot continue ${label}`,
              );
            }
            currentJwt = trimmed;
            emit({ kind: "info", text: "Token refreshed. Retrying…" });
          }
        }
        // Unreachable — loop either returns or throws.
        throw new Error("withFreshJwt: unreachable");
      }

      const onFontProgress = (ev: ImportProgressEvent) => {
        if (ev.kind === "font_uploading") {
          emit({ kind: "log", source: "stdout", text: `uploading font: ${ev.family} (${ev.fileName})` });
        } else if (ev.kind === "font_registered") {
          emit({ kind: "log", source: "stdout", text: `registered font: ${ev.family}` });
        } else if (ev.kind === "fonts_done") {
          emit({ kind: "log", source: "stdout", text: `fonts done: ${ev.uploaded} uploaded, ${ev.skipped} skipped` });
        }
      };

      /**
       * Preflight gate for unresolved fonts. Klaviyo templates routinely use
       * proprietary fonts (Futura, Helvetica Neue Mono, custom brand faces)
       * that aren't on Google Fonts so we can't auto-fetch them — but they
       * also can't be silently dropped: templates land referencing fonts
       * that don't exist and rendering falls back to a generic sans/serif,
       * making the editor unusable until the merchant manually picks a
       * replacement (see Blackline Car Care 2026-05-21 troubleshoot).
       *
       * Behavior: re-check the brand kit so we only block on fonts the user
       * hasn't already added, then pause with a needs_input modal that
       * surfaces the missing families. User can:
       *   - "Continue (added them)" — proceeds; templates will reference
       *     fonts that now exist in the brand kit.
       *   - "Import anyway" / Skip — proceeds without adding; rendering
       *     falls back. Logged as a warn so it shows up in the troubleshoot
       *     bundle.
       *
       * questionKey is scoped by the font set so a later phase encountering
       * a NEW unresolved font triggers a fresh prompt rather than reusing
       * an unrelated cached answer.
       */
      async function preflightUnresolvedFonts(
        unresolved: Array<{ family: string; reason: string; usedBy: string[] }>,
        label: string,
      ): Promise<void> {
        if (unresolved.length === 0) return;
        let stillMissing: typeof unresolved;
        try {
          stillMissing = await withFreshJwt(
            (jwt) =>
              filterFontsNotInBrandKit(unresolved, { jwt, serverBase, account }),
            `checking brand kit for ${label} fonts`,
          );
        } catch (e: any) {
          emit({
            kind: "warn",
            text: `Could not check brand kit for existing fonts (${e.message ?? e}). Prompting for all unresolved.`,
          });
          stillMissing = unresolved;
        }
        if (stillMissing.length === 0) {
          emit({
            kind: "info",
            text: `Unresolved ${label} fonts already present in brand kit — proceeding.`,
          });
          return;
        }
        const fontKey = stillMissing
          .map((u) => u.family.toLowerCase())
          .sort()
          .join("|");
        const fontList = stillMissing
          .map((u) => `• ${u.family} — used by ${u.usedBy.join(", ")}`)
          .join("\n");
        const plural = stillMissing.length === 1 ? "" : "s";
        const answer = await ctrl.prompt({
          questionKey: `font-preflight:${fontKey}`,
          question: `${stillMissing.length} custom font${plural} couldn't be auto-uploaded. Add ${stillMissing.length === 1 ? "it" : "them"} to your Redo brand kit (Settings → Brand Kit → Fonts), then click "Continue".`,
          context: `These fonts aren't on Google Fonts so they can't be fetched automatically:\n\n${fontList}\n\nWithout adding them, the imported templates will reference fonts that don't exist and fall back to a generic sans/serif at render time.`,
          type: "boolean",
          default: "true",
          trueLabel: "Continue (added them)",
          falseLabel: "Import anyway",
          itemLabel: `${stillMissing.length} unresolved font${plural}`,
          hideApplyAll: true,
        });
        if (answer === "false" || answer === "__skip__") {
          emit({
            kind: "warn",
            text: `Importing ${label} anyway with ${stillMissing.length} unresolved font${plural} (${stillMissing.map((u) => u.family).join(", ")}) — fallback rendering will apply.`,
          });
        } else {
          emit({
            kind: "info",
            text: `${label}: proceeding — assuming the ${stillMissing.length} missing font${plural} ${stillMissing.length === 1 ? "has" : "have"} been added to brand kit.`,
          });
        }
      }

      // ─── Template phase ────────────────────────────────────────────
      let templateImportOk = 0;
      let templateImportFail = 0;
      if (hasTemplatesToImport) {
        // Load the exported template JSON once so we can upload fonts (union
        // across the batch) before creating templates.
        const loaded: Array<{ id: string; name: string; path: string; json: any }> = [];
        for (const exp of exported) {
          try {
            const json = JSON.parse(readFileSync(exp.path, "utf8"));
            loaded.push({ ...exp, json });
          } catch (e: any) {
            emit({ kind: "fail", id: exp.id, name: exp.name, error: `read export: ${e.message ?? e}` });
          }
        }

        // Font upload (once per batch). Auto-uploads resolvable fonts to the
        // brand kit; unresolved ones (not on Google Fonts) trigger a preflight
        // modal so the merchant can add them manually before templates land.
        try {
          emit({ kind: "step", label: "Uploading brand fonts…" });
          const fontResult = await withFreshJwt(
            (jwt) =>
              uploadFontsForTemplates(loaded.map((l) => l.json), {
                jwt,
                serverBase,
                account,
                onProgress: onFontProgress,
              }),
            "uploading fonts",
          );
          emit({
            kind: "fonts_done",
            uploaded: fontResult.uploaded,
            registeredFamilies: fontResult.registeredFamilies,
            skipped: fontResult.skipped,
            unresolved: fontResult.unresolved,
          });
          await preflightUnresolvedFonts(fontResult.unresolved, "templates");
        } catch (e: any) {
          emit({ kind: "warn", text: `font upload failed: ${e.message ?? e}. Continuing with template import.` });
        }

        emit({ kind: "step", label: "Creating templates…" });
        for (const l of loaded) {
          emit({ kind: "step", label: `Importing ${l.name}…` });
          try {
            const result = await withFreshJwt(
              (jwt) =>
                importTemplateRpc(l.json, {
                  jwt,
                  serverBase,
                  account,
                  // Standalone templates land in the merchant's "Saved
                  // templates" library tab, NOT "Previous emails". Per
                  // redoapp's split (SavedEmailTemplate vs EmailTemplate
                  // collections), this is just a different RPC.
                  asSavedTemplate: true,
                  onProgress: (ev: ImportProgressEvent) => {
                    if (ev.kind === "filter_created") {
                      emit({ kind: "log", source: "stdout", text: `filter created: ${ev.productFilterId}` });
                    } else if (ev.kind === "template_created") {
                      emit({ kind: "log", source: "stdout", text: `template created: ${ev.templateId}` });
                    }
                  },
                }),
              `importing template "${l.name}"`,
            );
            templateImportOk++;
            summary.emailsImported += 1;
            emit({ kind: "imported", id: l.id, name: l.name, templateId: result.templateId });
            ctrl.recordImported({ itemId: l.id, itemType: "email", name: l.name });
          } catch (e: any) {
            templateImportFail++;
            const msg = e.message ?? String(e);
            // Rich event for the troubleshoot bundle (error.txt); compact
            // `fail` event drives the UI's red-row indicator. Same split as
            // the flow path.
            emit({
              kind: "template_failed",
              id: l.id,
              name: l.name,
              error: msg,
            });
            emit({ kind: "fail", id: l.id, name: l.name, error: `import: ${msg}` });
          }
        }
      }

      // ─── Flow phase ────────────────────────────────────────────────
      let flowImportOk = 0;
      let flowImportFail = 0;
      if (hasFlowsToImport) {
        emit({ kind: "step", label: `Fetching Klaviyo metrics…` });
        const metrics = await fetchAllMetrics(klaviyoKey);

        // Resolver uses on-demand Klaviyo template fetches (flow-embedded
        // templates aren't in the /templates/ listing). Falls back to disk
        // if extract-templates.ts has been run for this merchant.
        const templateResolver = createTemplateResolver({
          merchantDir: join(MIME_ROOT, "migrations", merchantSlug),
          account,
          skipAi,
          klaviyoApiKey: klaviyoKey,
        });

        for (const flowId of flowIds) {
          emit({ kind: "step", label: `Fetching flow ${flowId}…` });
          let flowDetail: any;
          try {
            flowDetail = await klaviyo(
              `/flows/${flowId}/?additional-fields%5Bflow%5D=definition`,
              klaviyoKey,
            );
          } catch (e: any) {
            flowImportFail++;
            emit({ kind: "fail", id: flowId, name: flowId, error: `fetch flow: ${e.message ?? e}` });
            continue;
          }
          const flowName = flowDetail?.data?.attributes?.name ?? flowId;
          // Status diagnostics: surface the Klaviyo source status so the user
          // knows which flows to flip on after reviewing. All imports land
          // inactive in Redo regardless of Klaviyo status — see parser.ts.
          const klaviyoStatus = flowDetail?.data?.attributes?.status ?? "(unknown)";
          emit({
            kind: "info",
            text: `${flowName}: Klaviyo status="${klaviyoStatus}" → imported inactive (review before enabling)`,
          });

          emit({ kind: "step", label: `Parsing ${flowName}…` });
          let parsed;
          try {
            parsed = await parseFlow(flowDetail as KlaviyoFlow, metrics, {
              teamId: storeId,
              templateResolver,
              account,
            });
          } catch (e: any) {
            flowImportFail++;
            const errMsg = e?.message ?? String(e);
            emit({
              kind: "flow_failed",
              id: flowId,
              name: flowName,
              klaviyoStatus,
              error: `parse flow: ${errMsg}`,
              warningList: [],
              parsedAutomation: null,
              klaviyoFlow: flowDetail,
            });
            emit({ kind: "fail", id: flowId, name: flowName, error: `parse flow: ${errMsg}` });
            continue;
          }
          // Recoverable skip: the auto-resolver couldn't map this Klaviyo
          // trigger to a Redo schema (e.g. custom-event metric). Prompt the
          // user to pick one and re-parse with the override before failing.
          if (!parsed.automation && parsed.skipped?.recoverable) {
            const klaviyoT: any = parsed.skipped.klaviyoTrigger ?? {};
            const klaviyoMetricId = typeof klaviyoT.id === "string" ? klaviyoT.id : null;
            const klaviyoMetric = klaviyoMetricId ? metrics[klaviyoMetricId] : null;
            const triggerContext = klaviyoMetric
              ? `Klaviyo trigger: ${klaviyoT.type} on metric "${klaviyoMetric.name}"${klaviyoMetric.integration_name ? ` (${klaviyoMetric.integration_name})` : ""}`
              : `Klaviyo trigger type: ${klaviyoT.type ?? "unknown"}`;
            const answer = await ctrl.prompt({
              questionKey: `flow-trigger:${flowId}`,
              question: `Pick a Redo trigger for "${flowName}"`,
              context: `${triggerContext}. Pick the closest Redo equivalent — once configured the rest of the flow imports as-is.`,
              type: "choice",
              options: MARKETING_TRIGGER_OPTIONS.map((o) => ({
                value: o.value,
                label: o.label,
              })),
              itemId: flowId,
              itemLabel: flowName,
              // Per-flow question key — there's no shared answer to apply
              // across other flows, so suppress the misleading checkbox.
              hideApplyAll: true,
            });
            // Modal "Skip this item" sends "__skip__"; treat as a graceful
            // skip rather than a hard error — the user explicitly declined.
            if (answer === "__skip__") {
              flowImportFail++;
              emit({
                kind: "fail",
                id: flowId,
                name: flowName,
                error: `skipped: user chose not to pick a trigger`,
              });
              continue;
            }
            const picked = findOptionByValue(answer);
            if (!picked) {
              flowImportFail++;
              emit({
                kind: "fail",
                id: flowId,
                name: flowName,
                error: `unknown trigger choice "${answer}" — flow skipped`,
              });
              continue;
            }
            emit({
              kind: "info",
              text: `Trigger for ${flowName}: ${picked.label} (chosen by user)`,
            });
            try {
              parsed = await parseFlow(flowDetail as KlaviyoFlow, metrics, {
                teamId: storeId,
                templateResolver,
                account,
                forcedTrigger: picked.resolution,
              });
            } catch (e: any) {
              flowImportFail++;
              emit({ kind: "fail", id: flowId, name: flowName, error: `parse flow (with chosen trigger): ${e.message ?? e}` });
              continue;
            }
          }
          if (!parsed.automation) {
            flowImportFail++;
            emit({
              kind: "fail",
              id: flowId,
              name: flowName,
              error: `skipped: ${parsed.skipped?.reason ?? "could not resolve trigger"}`,
            });
            continue;
          }

          // Needs-input hook: if the flow has a transactional-email warning,
          // ask the user whether to route through Redo's transactional send
          // path before importing. Repeated questions across items are
          // auto-answered from the job's cache (ask-once behavior). Answer
          // is recorded but V1 doesn't change import behavior based on it —
          // wire-up is a follow-up.
          const hasTxnWarning = parsed.warnings.some((w) =>
            typeof w.message === "string" && w.message.includes("transactional"),
          );
          if (hasTxnWarning) {
            const answer = await ctrl.prompt({
              questionKey: "transactional-routing",
              question: `Flow "${flowName}" has a send-email step marked transactional. Route it through Redo's transactional send path?`,
              context: "Transactional emails bypass merchant unsubscribe state. Klaviyo lets merchants flag specific sends transactional; Redo requires routing through a separate send path to preserve that behavior.",
              type: "boolean",
              default: "false",
              itemId: flowId,
              itemLabel: flowName,
            });
            emit({
              kind: "info",
              text: `Transactional routing for ${flowName}: ${answer === "true" ? "yes" : "no"}`,
            });
          }

          // Font upload + preflight gate (per-flow). Mirrors the template
          // phase: auto-upload resolvable fonts referenced by this flow's
          // placeholder templates, then pause if any custom families aren't
          // on Google Fonts so the merchant can add them manually. Repeated
          // font sets across flows hit the ask-once cache (questionKey is
          // scoped by the font list).
          try {
            const placeholderJsons = parsed.placeholderTemplates
              .map((p: any) => p.fullTemplate)
              .filter((t: any): t is { _fontPlan?: any; name?: string } => !!t);
            if (placeholderJsons.length > 0) {
              const fontResult = await withFreshJwt(
                (jwt) =>
                  uploadFontsForTemplates(placeholderJsons, {
                    jwt,
                    serverBase,
                    account,
                    onProgress: onFontProgress,
                  }),
                `uploading fonts for flow "${flowName}"`,
              );
              emit({
                kind: "fonts_done",
                uploaded: fontResult.uploaded,
                registeredFamilies: fontResult.registeredFamilies,
                skipped: fontResult.skipped,
                unresolved: fontResult.unresolved,
              });
              await preflightUnresolvedFonts(
                fontResult.unresolved,
                `flow "${flowName}"`,
              );
            }
          } catch (e: any) {
            emit({
              kind: "warn",
              text: `font upload failed for flow "${flowName}": ${e.message ?? e}. Continuing with flow import.`,
            });
          }

          emit({ kind: "step", label: `Importing ${flowName}…` });
          try {
            const result = await withFreshJwt(
              (jwt) => importFlowRpc(
              {
                automation: parsed.automation as any,
                warnings: parsed.warnings as any,
                placeholderTemplates: parsed.placeholderTemplates as any,
                placeholderSmsTemplates: parsed.placeholderSmsTemplates as any,
              },
              {
                jwt,
                serverBase,
                account,
                onProgress: (ev: ImportProgressEvent) => {
                  if (ev.kind === "filter_created") {
                    emit({ kind: "log", source: "stdout", text: `filter created: ${ev.productFilterId}` });
                  } else if (ev.kind === "template_created") {
                    emit({ kind: "log", source: "stdout", text: `  email template created: ${ev.templateId}` });
                  } else if (ev.kind === "flow_created") {
                    emit({ kind: "log", source: "stdout", text: `flow created: ${ev.flowId}` });
                  } else if (ev.kind === "template_failed") {
                    // Debug breadcrumb from importFlowRpc on createAdvancedFlow failure
                    // — templateName is `[flow debug] <name>`, error holds the step summary.
                    emit({ kind: "log", source: "stderr", text: `${ev.templateName}: ${ev.error}` });
                  } else if (ev.kind === "flow_failed") {
                    emit({ kind: "log", source: "stderr", text: `flow failed (${ev.flowName}): ${ev.error}` });
                  }
                },
              },
            ),
              `importing flow "${flowName}"`,
            );
            flowImportOk++;
            const flowEmails =
              (result.createdTemplateCount ?? 0) +
              (result.blankTemplateCount ?? 0);
            summary.emailsImported += flowEmails;
            ctrl.recordImported({
              itemId: flowId,
              itemType: "flow",
              name: flowName,
              emailCount: flowEmails > 0 ? flowEmails : 1,
            });
            emit({
              kind: "flow_imported",
              id: flowId,
              name: flowName,
              flowId: result.flowId,
              createdTemplateCount: result.createdTemplateCount,
              blankTemplateCount: result.blankTemplateCount,
              warningCount: parsed.warnings.length,
              // Surfaced for the UI's "imported as draft / live" badge and
              // to make the Klaviyo-status → Redo-enabled mapping visible
              // in the per-job log.
              enabled: parsed.automation?.enabled === true,
              klaviyoStatus,
              // For the troubleshoot bundle: full warnings + parsed automation
              // tree so we can re-construct a per-flow report without re-running.
              warningList: parsed.warnings,
              parsedAutomation: parsed.automation,
              // Snapshot Klaviyo source. Mirrors flow_failed payload — lets the
              // troubleshoot bundle include klaviyo-flow.json for successful
              // imports too (Replit's filesystem is stateless across restarts,
              // so the migrations/<slug>/flows/ dir is empty by the time the
              // operator opens the bundle endpoint).
              klaviyoFlow: flowDetail,
            });
          } catch (e: any) {
            flowImportFail++;
            const errMsg = e?.message ?? String(e);
            // Capture EVERYTHING needed to debug a failed import in the
            // troubleshoot bundle: the parsed automation we tried to send,
            // the Klaviyo source flow, and the full error string. Without
            // this the bundle for a failed flow has nothing useful in it.
            // Emit a `flow_failed` alongside the user-facing `fail` so the
            // bundle builder can find the data; the `fail` event drives the
            // UI's red-row indicator and stays compact.
            emit({
              kind: "flow_failed",
              id: flowId,
              name: flowName,
              klaviyoStatus,
              error: errMsg,
              warningList: parsed.warnings,
              parsedAutomation: parsed.automation,
              klaviyoFlow: flowDetail,
            });
            emit({ kind: "fail", id: flowId, name: flowName, error: `import: ${errMsg}` });
          }
        }
      }

      // ─── Campaign phase ────────────────────────────────────────────
      // Each selected campaignId → fetch its messages → for each message,
      // resolve the template via Klaviyo API → createEmailTemplate in Redo.
      // A/B variants (multiple messages per campaign) produce multiple
      // EmailTemplates with variant-suffixed names. No AdvancedFlow is
      // created; the merchant kicks off the send from Redo's UI.
      let campaignImportOk = 0;
      let campaignImportFail = 0;
      if (hasCampaignsToImport) {
        // Template resolver (API-only; we never cache campaign-embedded
        // templates on disk — they're non-reusable clones that would only
        // fill the merchants folder).
        const campaignTemplateResolver = createTemplateResolver({
          merchantDir: join(MIME_ROOT, "migrations", merchantSlug),
          account,
          skipAi,
          klaviyoApiKey: klaviyoKey,
        });

        for (const campaignId of campaignIds) {
          emit({ kind: "step", label: `Fetching campaign ${campaignId}…` });
          let campaignName = campaignId;
          let messages: any[] = [];
          try {
            const campaignRes: any = await klaviyo(
              `/campaigns/${campaignId}/?fields%5Bcampaign%5D=name,status`,
              klaviyoKey,
            );
            campaignName = campaignRes?.data?.attributes?.name ?? campaignId;
            const msgsRes: any = await klaviyo(
              `/campaigns/${campaignId}/campaign-messages/`,
              klaviyoKey,
            );
            messages = msgsRes?.data ?? [];
          } catch (e: any) {
            campaignImportFail++;
            emit({
              kind: "fail",
              id: campaignId,
              name: campaignName,
              error: `fetch campaign: ${e.message ?? e}`,
            });
            continue;
          }

          if (messages.length === 0) {
            campaignImportFail++;
            emit({
              kind: "fail",
              id: campaignId,
              name: campaignName,
              error: "no campaign-messages found",
            });
            continue;
          }

          let createdTemplateCount = 0;
          let variantFailures = 0;
          for (const m of messages) {
            let tplId: string | null =
              m.relationships?.template?.data?.id ?? null;
            if (!tplId) {
              try {
                const rel: any = await klaviyo(
                  `/campaign-messages/${m.id}/relationships/template/`,
                  klaviyoKey,
                );
                tplId = rel?.data?.id ?? null;
              } catch {
                // no template
              }
            }
            if (!tplId) {
              variantFailures++;
              emit({
                kind: "warn",
                text: `campaign "${campaignName}" message ${m.id} has no template — skipped`,
              });
              continue;
            }

            // Build a per-variant name. Klaviyo exposes a `label` on the
            // campaign-message (e.g. "Variation A"); fall back to a letter
            // index when missing. Messages with only one variant get the
            // bare campaign name.
            const label: string | null = m.attributes?.label ?? null;
            const variantName =
              messages.length === 1
                ? campaignName
                : label
                  ? `${campaignName} — ${label}`
                  : `${campaignName} — variant ${String.fromCharCode(
                      65 + messages.indexOf(m),
                    )}`;

            emit({ kind: "step", label: `Resolving ${variantName}…` });
            const resolved = campaignTemplateResolver
              ? await campaignTemplateResolver.resolve(tplId)
              : null;
            if (!resolved || "failure" in resolved) {
              variantFailures++;
              const detail = resolved && "failure" in resolved
                ? `${resolved.failure.reason}: ${resolved.failure.detail}`
                : `resolver not configured`;
              emit({
                kind: "fail",
                id: `${campaignId}:${m.id}`,
                name: variantName,
                error: `could not resolve Klaviyo template ${tplId} — ${detail}`,
              });
              continue;
            }

            const templateJson = {
              ...resolved.template,
              name: variantName.slice(0, 200),
              subject:
                m.attributes?.definition?.content?.subject ??
                resolved.template.subject ??
                "",
              emailPreview:
                m.attributes?.definition?.content?.preview_text ??
                resolved.template.emailPreview ??
                null,
            };

            emit({ kind: "step", label: `Importing ${variantName}…` });
            try {
              const result = await withFreshJwt(
                (jwt) => importTemplateRpc(templateJson, {
                  jwt,
                  serverBase: bodyRedoServerBase,
                  account,
                  // Campaigns are standalone email sends; they belong in
                  // the merchant's "Saved templates" library, not in the
                  // "Previous emails" timeline of past sends. Same RPC
                  // switch as the standalone template-import phase above.
                  asSavedTemplate: true,
                  onProgress: (ev: ImportProgressEvent) => {
                    if (ev.kind === "filter_created") {
                      emit({
                        kind: "log",
                        source: "stdout",
                        text: `filter created: ${ev.productFilterId}`,
                      });
                    } else if (ev.kind === "template_created") {
                      emit({
                        kind: "log",
                        source: "stdout",
                        text: `  campaign template created: ${ev.templateId}`,
                      });
                    }
                  },
                }),
                `importing campaign variant "${variantName}"`,
              );
              createdTemplateCount++;
              summary.emailsImported += 1;
              emit({
                kind: "imported",
                id: `${campaignId}:${m.id}`,
                name: variantName,
                templateId: result.templateId,
              });
              ctrl.recordImported({
                itemId: `${campaignId}:${m.id}`,
                itemType: "email",
                name: variantName,
              });
            } catch (e: any) {
              variantFailures++;
              const msg = e.message ?? String(e);
              emit({
                kind: "template_failed",
                id: `${campaignId}:${m.id}`,
                name: variantName,
                error: msg,
              });
              emit({
                kind: "fail",
                id: `${campaignId}:${m.id}`,
                name: variantName,
                error: `import: ${msg}`,
              });
            }
          }

          // Emit a per-campaign summary event so the UI can flip the
          // campaign row to "done" after all its variants resolve.
          if (createdTemplateCount > 0) {
            campaignImportOk++;
            emit({
              kind: "campaign_imported",
              id: campaignId,
              name: campaignName,
              createdTemplateCount,
              variantFailures,
            });
          } else {
            campaignImportFail++;
          }
        }
      }

      summary.templatesImported = templateImportOk;
      summary.templatesFailed = templateImportFail;
      summary.flowsImported = flowImportOk;
      summary.flowsFailed = flowImportFail;
      summary.campaignsImported = campaignImportOk;
      summary.campaignsFailed = campaignImportFail;
      emit({
        kind: "done",
        importMethod: "rpc",
        imported: templateImportOk,
        importFailed: templateImportFail,
        flowsImported: flowImportOk,
        flowsFailed: flowImportFail,
        campaignsImported: campaignImportOk,
        campaignsFailed: campaignImportFail,
      });
      return summary;
    }

    // ─── Import via bazel (local only, templates only) ─────────────────
    if (!hasTemplatesToImport) {
      emit({ kind: "done", importSkipped: true });
      return summary;
    }
    emit({ kind: "step", label: "Importing into Redo (bazel)…" });

    const importArgs = [
      "run",
      "//redo/manage:import-klaviyo-templates",
      "--",
      "--team",
      storeId,
      "--account",
      merchantSlug,
      "--mime-dir",
      MIME_ROOT,
    ];

    const proc = spawn("bazel", importArgs, {
      cwd: redoappDir,
      env: process.env,
    });

    // Auto-confirm the manage script's "Import N template(s)? (y/n)" prompt
    proc.stdin.write("y\n");
    proc.stdin.end();

    proc.stdout.on("data", (buf) => {
      const lines = buf.toString().split("\n").filter(Boolean);
      for (const line of lines) emit({ kind: "log", source: "stdout", text: line });
    });
    proc.stderr.on("data", (buf) => {
      const lines = buf.toString().split("\n").filter(Boolean);
      for (const line of lines) emit({ kind: "log", source: "stderr", text: line });
    });

    await new Promise<void>((resolveProc) => {
      proc.on("close", (code) => {
        emit({ kind: "done", importExitCode: code });
        resolveProc();
      });
    });
  return summary;
}

// ─── API: /api/run (legacy NDJSON stream) ──────────────────────────────────
// Streams events directly to the response. Kept for backwards compat with
// the current inline HTML UI. New clients should use POST /api/jobs.

async function handleRun(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody(req);
  const params = parseRunBody(body);
  if ("error" in params) {
    return json(res, 400, { error: params.error });
  }

  ndjsonStart(res);
  const ctrl = resController(res);

  try {
    await runImport(params, ctrl);
  } catch (e: any) {
    ctrl.emit({ kind: "error", severity: "error", text: e.message ?? String(e) });
  } finally {
    res.end();
  }
}

// ─── API: POST /api/jobs — create + run a job asynchronously ──────────────
// Unlike /api/run, this returns immediately with the job id. The client
// then streams events from GET /api/jobs/:id/stream and optionally answers
// needs_input prompts via POST /api/jobs/:id/inputs.

async function handleJobCreate(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody(req);
  const params = parseRunBody(body);
  if ("error" in params) {
    return json(res, 400, { error: params.error });
  }
  const storeName = (body.storeName as string | undefined)?.trim() || params.merchantSlug;

  const job = createJob({
    storeId: params.storeId,
    storeName,
    merchantSlug: params.merchantSlug,
    templateIds: params.templateIds,
    flowIds: params.flowIds,
  });
  const ctrl = jobController(job.id);

  // Respond immediately with the job id.
  json(res, 202, { jobId: job.id, status: job.status });

  // Kick off the pipeline in the background. Errors funnel into the job log
  // + status transitions; exceptions are never rethrown to the HTTP server.
  setStatus(job.id, "running");
  void runImport(params, ctrl)
    .then((summary) => {
      setStatus(job.id, "completed", { summary });
    })
    .catch((e: any) => {
      ctrl.emit({
        kind: "error",
        severity: "error",
        text: e?.message ?? String(e),
      });
      setStatus(job.id, "failed", { error: e?.message ?? String(e) });
    });
}

// ─── API: GET /api/jobs — list jobs (optionally scoped to a store) ────────

async function handleJobList(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
  const storeId = url.searchParams.get("storeId") ?? undefined;
  const jobs = listJobs(storeId ? { storeId } : undefined).map((j) => ({
    id: j.id,
    storeId: j.storeId,
    storeName: j.storeName,
    merchantSlug: j.merchantSlug,
    status: j.status,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    completedAt: j.completedAt,
    templateIds: j.templateIds,
    flowIds: j.flowIds,
    eventCount: j.events.length,
    summary: j.summary,
    error: j.error,
    // Tail of the event stream for a compact dashboard preview
    lastEvent: j.events[j.events.length - 1] ?? null,
    pendingInput: j.pendingInput ?? null,
  }));
  json(res, 200, { jobs });
}

// ─── API: GET /api/jobs/:id — full detail ─────────────────────────────────

async function handleJobGet(res: ServerResponse, jobId: string) {
  // Refresh notes from DB so the admin sees notes the reviewer wrote on
  // the separate public_review deploy. Mime runs as two processes sharing
  // one Postgres; in-memory job.notes is stale on whichever process
  // didn't write the note.
  await refreshJobNotesFromDb(jobId);
  const job = getJob(jobId);
  if (!job) return json(res, 404, { error: `job ${jobId} not found` });
  json(res, 200, job);
}

// ─── API: GET /api/jobs/:id/stream — NDJSON live stream ───────────────────
// Sends all historical events first, then streams new ones until the job
// completes OR the client disconnects. Safe to reconnect (replays history).

async function handleJobStream(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
) {
  const job = getJob(jobId);
  if (!job) return json(res, 404, { error: `job ${jobId} not found` });

  const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
  const since = Number(url.searchParams.get("since") ?? "0");

  ndjsonStart(res);

  // 1. Replay historical events past `since`.
  for (const e of job.events) {
    if (e.seq > since) res.write(JSON.stringify(e) + "\n");
  }

  // 2. If job is already terminal, close out.
  const terminal = (status: string) =>
    status === "completed" || status === "failed" || status === "cancelled";
  if (terminal(job.status)) {
    res.end();
    return;
  }

  // 3. Otherwise subscribe to new events and stream them as they arrive.
  const unsubscribe = subscribe(jobId, (event) => {
    res.write(JSON.stringify(event) + "\n");
  });

  // Close the stream when the job reaches a terminal state. Poll the job
  // status on every event (cheap — just a map lookup) so we don't need
  // dedicated status-change notifications.
  const interval = setInterval(() => {
    const current = getJob(jobId);
    if (!current || terminal(current.status)) {
      clearInterval(interval);
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    }
  }, 500);

  // Heartbeat keeps the NDJSON stream alive across idle gaps — most
  // importantly the wait between emitting `needs_input` and receiving
  // the user's answer via POST /api/jobs/:id/inputs. Replit's autoscale
  // proxy kills idle streams in seconds; without this the client sees
  // `TypeError: network error` mid-import and the modal answer never
  // gets delivered. Mirrors `handleFlowsStream`'s pattern. The client
  // (mock-stream.js readNdjsonLines) treats unknown event kinds as
  // no-ops, so this is invisible to the UI.
  const heartbeat = setInterval(() => {
    res.write(JSON.stringify({ kind: "heartbeat", t: Date.now() }) + "\n");
  }, 10_000);

  req.on("close", () => {
    clearInterval(interval);
    clearInterval(heartbeat);
    unsubscribe();
  });
}

// ─── API: POST /api/jobs/:id/inputs — deliver an answer to needs_input ───

async function handleJobInput(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
) {
  const body = await readJsonBody(req);
  const inputId = body.inputId as string | undefined;
  const answer = body.answer;
  if (!inputId || answer === undefined) {
    return json(res, 400, { error: "inputId and answer required" });
  }
  const result = resolveInput(jobId, inputId, String(answer));
  if (!result.ok) return json(res, 400, result);
  json(res, 200, { ok: true });
}

// ─── API: DELETE /api/jobs/:id — remove a completed/failed job ───────────

async function handleJobDelete(res: ServerResponse, jobId: string) {
  const deleted = deleteJob(jobId);
  if (!deleted) return json(res, 404, { error: `job ${jobId} not found` });
  json(res, 200, { ok: true });
}

// ─── API: POST /api/jobs/:id/notes — upsert a per-item troubleshoot note ──
// Body: { itemId: string, note: string }. Empty note clears the entry.

async function handleJobNotes(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
) {
  const body = await readJsonBody(req);
  const itemId = body.itemId;
  const note = body.note;
  if (typeof itemId !== "string" || typeof note !== "string") {
    return json(res, 400, { error: "itemId and note (string) required" });
  }
  // Attribute admin-side notes to whoever's logged in (Austin / Michael)
  // so the troubleshoot panel can show "Saved by Michael". Falls back to
  // anonymous if the identity cookie isn't set.
  const author = getAdminUser(req) ?? undefined;
  const ok = setNote(jobId, itemId, note, author);
  if (!ok) return json(res, 404, { error: `job ${jobId} not found` });
  json(res, 200, { ok: true });
}

// ─── API: POST /api/jobs/:id/notes-resolve — toggle a note's resolved state ──
// Body: { itemId: string, resolved: boolean }. Preserves text + author;
// only flips the resolvedAt/resolvedBy fields. Returns 404 if the item has
// no note to resolve.

async function handleJobNoteResolve(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
) {
  const body = await readJsonBody(req);
  const itemId = body.itemId;
  const resolved = body.resolved;
  if (typeof itemId !== "string" || typeof resolved !== "boolean") {
    return json(res, 400, { error: "itemId (string) and resolved (boolean) required" });
  }
  const resolver = getAdminUser(req) ?? undefined;
  const ok = setNoteResolved(jobId, itemId, resolved, resolver);
  if (!ok) {
    return json(res, 404, {
      error: `no note to ${resolved ? "resolve" : "reopen"} on job ${jobId} item ${itemId}`,
    });
  }
  json(res, 200, { ok: true });
}

/**
 * Full admin gate — admin_token cookie AND a valid claim. Used on every
 * endpoint except the identity-pick flow and /api/me (which need to be
 * callable BEFORE the user has claimed an identity).
 *
 * Returns true if the request may proceed; false (and writes 401)
 * otherwise. Async because the claim check hits the DB.
 */
async function requireFullAdmin(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!requireAdmin(req, res)) return false;
  // Local dev (no ADMIN_URL_TOKEN) → no claims either; admin_token
  // already bypassed, treat claim as bypassed too.
  if (!isAdminAuthEnabled()) return true;
  const claimToken = getAdminClaimToken(req);
  const claimedUser = await userForClaimToken(claimToken);
  if (claimedUser) return true;
  // Claim missing or invalid. If no one has claimed anything yet, allow
  // through so the first visitor can do anything they need before they
  // hit the identity modal. Once any claim exists, the gate locks.
  const status = await getClaimStatus(claimToken);
  if (status.claimedUsers.length === 0) return true;
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({
    error: "admin claim required",
    detail: "pick your identity first (or both slots are taken)",
  }));
  return false;
}

// ─── Admin identity (Austin / Michael) ──────────────────────────────────
//
// First-visit modal picks Austin or Michael. The slot is claimed in
// admin_claims and tied to the browser via the HttpOnly admin_claim
// cookie. Once both slots are claimed, no new browser can authenticate
// as either — the modal disables taken options and any API call that
// requires admin returns 401 until they present a matching claim cookie.

async function handleAdminIdentityGet(req: IncomingMessage, res: ServerResponse) {
  const claimToken = getAdminClaimToken(req);
  const status = await getClaimStatus(claimToken);
  // Prefer the DB-verified identity when the cookie validates against a
  // claim; fall back to the un-validated admin_user cookie (legacy / no
  // DB available) just so we don't blow up local dev.
  const user = status.myClaim ?? getAdminUser(req);
  json(res, 200, {
    user,
    claimedUsers: status.claimedUsers,
  });
}

async function handleAdminIdentitySet(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody(req);
  const user = typeof body.user === "string" ? body.user.trim() : "";
  if (!isAllowedAdminUser(user)) {
    return json(res, 400, { error: "user must be Austin or Michael" });
  }
  const existingToken = getAdminClaimToken(req);
  const outcome = await tryClaim(user, existingToken);
  if (!outcome.ok) {
    if (outcome.reason === "already_claimed") {
      return json(res, 403, {
        error: "this identity is already claimed by another browser",
      });
    }
    // db_unavailable — fall back to the legacy in-memory cookie-only flow
    // so local dev (no DATABASE_URL) still works. No claim is recorded.
    setAdminUserCookie(res, user);
    return json(res, 200, { user });
  }
  setAdminUserCookie(res, user);
  if (!outcome.existed) {
    // First-time claim; set the proof cookie.
    setAdminClaimCookie(res, outcome.token);
  } else if (!existingToken) {
    // Re-affirm an existing claim that's somehow lost its cookie locally.
    setAdminClaimCookie(res, outcome.token);
  }
  json(res, 200, { user });
}

async function handleAdminIdentityClear(_req: IncomingMessage, res: ServerResponse) {
  // Only clears the cookies locally — the claim row in admin_claims
  // stays so the slot remains owned. A new "switch user" press just
  // re-shows the modal; the next pick must match the existing claim
  // (your own slot) or be the other still-unclaimed name.
  clearAdminUserCookie(res);
  json(res, 200, { ok: true });
}

// "Who am I?" — used by the assist UI to decide whether to show the
// "← Admin" back-link. Returns the verified admin identity (if any) and
// the URL to the admin dashboard so the link is correct even when the
// admin URL token rotates.
async function handleMe(req: IncomingMessage, res: ServerResponse) {
  const adminViaCookie = isAdmin(req);
  // Local dev (no ADMIN_URL_TOKEN) skips the claim check — adminViaCookie
  // already trusts everything. In prod, the claim cookie has to match a
  // row in admin_claims for the back-link to appear.
  if (!isAdminAuthEnabled()) {
    return json(res, 200, {
      isAdmin: adminViaCookie,
      adminUser: getAdminUser(req),
      adminUrl: adminViaCookie ? `${adminPathPrefix()}/` : null,
    });
  }
  const claimToken = getAdminClaimToken(req);
  const claimedUser = await userForClaimToken(claimToken);
  const verified = adminViaCookie && claimedUser !== null;
  json(res, 200, {
    isAdmin: verified,
    adminUser: verified ? claimedUser : null,
    adminUrl: verified ? `${adminPathPrefix()}/` : null,
  });
}

// ─── Admin metrics — running "Hours saved" tally for the header ──────────

async function handleAdminMetrics(_req: IncomingMessage, res: ServerResponse) {
  const totalEmails = await getTotalEmailsImported();
  const totalHours = emailsToHours(totalEmails);
  json(res, 200, { totalEmails, totalHours });
}

// ─── Assist API: read-only store + items list, plus note write ───────────
//
// These endpoints power the public-facing /assist UI. They sit inside the
// Replit Private Deployment fence (so only invited Replit users reach
// them) but require no admin cookie — assistants don't have one.
//
// Notes written here go into the same jobs.notes JSONB store the admin
// dashboard reads, so anything written on /assist appears in the existing
// Toby troubleshoot panel automatically.

function readAsParam(req: IncomingMessage): string | undefined {
  const u = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
  const raw = u.searchParams.get("as");
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, 60);
}

async function handleAssistStores(req: IncomingMessage, res: ServerResponse) {
  const stores = await listAssistStores(readAsParam(req));
  json(res, 200, { stores });
}

async function handleAssistItems(
  req: IncomingMessage,
  res: ServerResponse,
  storeId: string,
) {
  const { storeName, items } = await listAssistItemsForStore(
    storeId,
    readAsParam(req),
  );
  json(res, 200, { storeName, items });
}

async function handleAssistDone(
  req: IncomingMessage,
  res: ServerResponse,
  storeId: string,
  itemId: string,
) {
  const body = await readJsonBody(req);
  const done = body.done === true;
  const author = typeof body.author === "string" ? body.author.trim() : "";
  if (!author) {
    return json(res, 400, { error: "author required to mark done" });
  }
  await setAssistDone(storeId, itemId, author, done);
  json(res, 200, { ok: true, done });
}

// ─── Assist API: per-user brand-card ordering ──────────────────────────────
//
// GET  /api/assist/cards/order?as=Dennis  → { storeIds: string[] }
// POST /api/assist/cards/order            → { ok: true }
//   body: { storeIds: string[], author: string }
//
// The UI reads the order on mount and applies it client-side (stores
// missing from the saved list fall through to the default
// last-imported-at sort). On drag-end, the UI POSTs the new full
// order; the server replaces all rows for the user atomically.

async function handleAssistCardsOrderGet(req: IncomingMessage, res: ServerResponse) {
  const as = readAsParam(req);
  if (!as) return json(res, 200, { storeIds: [] });
  const storeIds = await getCardOrder(as);
  json(res, 200, { storeIds });
}

async function handleAssistCardsOrderSet(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody(req);
  const author = typeof body.author === "string" ? body.author.trim() : "";
  if (!author) return json(res, 400, { error: "author required" });
  const raw = body.storeIds;
  if (!Array.isArray(raw)) {
    return json(res, 400, { error: "storeIds must be an array" });
  }
  const storeIds: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && v.trim() !== "") storeIds.push(v.trim());
  }
  await setCardOrder(author, storeIds);
  json(res, 200, { ok: true });
}

async function handleAssistNote(
  req: IncomingMessage,
  res: ServerResponse,
  storeId: string,
  itemId: string,
) {
  const body = await readJsonBody(req);
  const note = typeof body.note === "string" ? body.note : "";
  const author = typeof body.author === "string" ? body.author.trim() : "";

  const jobId = await findLatestJobForItem(storeId, itemId);
  if (!jobId) {
    return json(res, 404, { error: "no imported item matching that id" });
  }
  const ok = setNote(jobId, itemId, note, author || undefined);
  if (!ok) return json(res, 404, { error: `job ${jobId} not found` });

  // Return the canonical shape so the UI can render the "saved by …" line
  // without round-tripping through a separate fetch.
  const savedNote = note.trim() === ""
    ? null
    : {
        text: note,
        author: author || null,
        savedAt: new Date().toISOString(),
      };
  json(res, 200, { ok: true, note: savedNote });
}

// ─── API: POST /api/jobs/:id/bundle — stream a troubleshoot zip ──────────
// Body: { items: [{ id: string, type: "template" | "flow" }] }.

async function handleJobBundle(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
) {
  // Same cross-process freshness as handleJobGet — reviewer-written
  // notes need to land in the bundle's notes.md files.
  await refreshJobNotesFromDb(jobId);
  const job = getJob(jobId);
  if (!job) return json(res, 404, { error: `job ${jobId} not found` });
  const body = await readJsonBody(req);
  const rawItems = Array.isArray(body.items) ? body.items : null;
  if (!rawItems || rawItems.length === 0) {
    return json(res, 400, { error: "items: non-empty array required" });
  }
  const items: BundleItemRequest[] = [];
  for (const raw of rawItems) {
    if (
      raw &&
      typeof raw.id === "string" &&
      (raw.type === "template" || raw.type === "flow")
    ) {
      items.push({ id: raw.id, type: raw.type });
    }
  }
  if (items.length === 0) {
    return json(res, 400, { error: "no valid items (each needs id + type)" });
  }
  const stamp = job.completedAt ?? job.createdAt;
  const safeStamp = stamp.replace(/[:.]/g, "-");
  res.writeHead(200, {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="troubleshoot-${job.merchantSlug}-${safeStamp}.zip"`,
  });
  try {
    await streamBundle(job, items, res);
  } catch (e: any) {
    console.error("[bundle] stream failed:", e);
    if (!res.writableEnded) res.end();
  }
}

// ─── API: /api/stores — server-side merchant credential store ────────────
// Replaces the browser-localStorage persistence so (a) Claude can run
// resolver diagnostics autonomously, (b) keys outlive a browser, (c) the
// JWT can be rotated in one place when it expires. See src/migrate/stores.ts.

async function handleStoresList(_req: IncomingMessage, res: ServerResponse) {
  if (!isDbEnabled()) return json(res, 200, { stores: [] });
  try {
    const records = await listStores();
    json(res, 200, { stores: records.map(toSummary) });
  } catch (e: any) {
    json(res, 500, { error: e.message ?? String(e) });
  }
}

async function handleStoreGet(res: ServerResponse, id: string) {
  if (!isDbEnabled()) return json(res, 503, { error: "DB not enabled" });
  try {
    const rec = await getStoreById(id);
    if (!rec) return json(res, 404, { error: `store ${id} not found` });
    // Returns the full record including unmasked keys — that's the whole
    // point: the UI's edit form populates from this, and the debug
    // endpoint resolves keys server-side.
    json(res, 200, { store: rec });
  } catch (e: any) {
    json(res, 500, { error: e.message ?? String(e) });
  }
}

async function handleStoreCreate(req: IncomingMessage, res: ServerResponse) {
  if (!isDbEnabled()) return json(res, 503, { error: "DB not enabled" });
  const body = await readJsonBody(req);
  const name = String(body.name ?? "").trim();
  const merchantSlug = String(body.merchantSlug ?? "").trim();
  const klaviyoKey = String(body.klaviyoKey ?? "").trim();
  const storeId = String(body.storeId ?? "").trim();
  const redoJwt = body.redoJwt ? String(body.redoJwt).trim() : null;
  const redoServerBase = body.redoServerBase ? String(body.redoServerBase).trim() : null;
  if (!name || !merchantSlug || !klaviyoKey || !storeId) {
    return json(res, 400, {
      error: "name, merchantSlug, klaviyoKey, and storeId required",
    });
  }
  try {
    const rec = await createStore({
      name,
      merchantSlug,
      klaviyoKey,
      redoJwt,
      storeId,
      redoServerBase,
      createdBy: getAdminUser(req),
    });
    json(res, 201, { store: rec });
  } catch (e: any) {
    // Most likely cause: merchant_slug uniqueness violation. Surface a
    // 409 so the UI can show "already exists, edit instead?".
    const msg = e?.message ?? String(e);
    if (msg.includes("idx_stores_slug") || msg.includes("duplicate key")) {
      return json(res, 409, { error: `merchantSlug "${merchantSlug}" already exists` });
    }
    json(res, 500, { error: msg });
  }
}

async function handleStoreUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
) {
  if (!isDbEnabled()) return json(res, 503, { error: "DB not enabled" });
  const body = await readJsonBody(req);
  const patch: Record<string, unknown> = {};
  // Only forward fields the client explicitly sent — empty strings stay
  // as empty strings (the JWT field uses "" to clear a stale token).
  if (typeof body.name === "string") patch.name = body.name.trim();
  if (typeof body.merchantSlug === "string") patch.merchantSlug = body.merchantSlug.trim();
  if (typeof body.klaviyoKey === "string") patch.klaviyoKey = body.klaviyoKey.trim();
  if (typeof body.storeId === "string") patch.storeId = body.storeId.trim();
  if (typeof body.redoJwt === "string") patch.redoJwt = body.redoJwt.trim() || null;
  if (typeof body.redoServerBase === "string") {
    patch.redoServerBase = body.redoServerBase.trim() || null;
  }
  try {
    const rec = await updateStore(id, patch as any);
    if (!rec) return json(res, 404, { error: `store ${id} not found` });
    json(res, 200, { store: rec });
  } catch (e: any) {
    json(res, 500, { error: e.message ?? String(e) });
  }
}

async function handleStoreDelete(res: ServerResponse, id: string) {
  if (!isDbEnabled()) return json(res, 503, { error: "DB not enabled" });
  try {
    const ok = await deleteStore(id);
    if (!ok) return json(res, 404, { error: `store ${id} not found` });
    json(res, 200, { ok: true });
  } catch (e: any) {
    json(res, 500, { error: e.message ?? String(e) });
  }
}

// ─── API: /api/debug/resolve-template ─────────────────────────────────────
// Read-only diagnostic: given a stored merchant slug + a Klaviyo template
// id, run the same resolver path the flow importer uses and return the
// outcome (typed ResolveFailure on miss, parse counts on hit). Lets Claude
// triage troubleshoot bundles without a human-in-the-loop JWT/key paste.

async function handleDebugResolveTemplate(
  req: IncomingMessage,
  res: ServerResponse,
) {
  if (!isDbEnabled()) return json(res, 503, { error: "DB not enabled" });
  const body = await readJsonBody(req);
  const merchantSlug = String(body.merchantSlug ?? "").trim();
  const templateId = String(body.templateId ?? "").trim();
  if (!merchantSlug || !templateId) {
    return json(res, 400, { error: "merchantSlug and templateId required" });
  }
  try {
    const store = await getStoreBySlug(merchantSlug);
    if (!store) {
      return json(res, 404, { error: `no store with merchantSlug "${merchantSlug}"` });
    }
    const account = await fetchAccount(store.klaviyoKey).catch(() => null);
    const resolver = createTemplateResolver({
      merchantDir: join(MIME_ROOT, "migrations", merchantSlug),
      account,
      skipAi: true,
      klaviyoApiKey: store.klaviyoKey,
    });
    if (!resolver) {
      return json(res, 200, {
        merchantSlug,
        templateId,
        result: {
          failure: {
            reason: "manifest-miss-no-api-key",
            detail: "no manifest on disk and no API key configured (unexpected — store has a key)",
          },
        },
      });
    }
    const result = await resolver.resolve(templateId);
    if ("failure" in result) {
      return json(res, 200, {
        merchantSlug,
        templateId,
        result: { failure: result.failure },
      });
    }
    // Don't echo the full template back — the response could be 100s of
    // KB. A summary is enough to confirm "yes, this resolves cleanly".
    return json(res, 200, {
      merchantSlug,
      templateId,
      result: {
        ok: true,
        sectionCount: Array.isArray(result.template.sections)
          ? result.template.sections.length
          : 0,
        warningCount: result.warnings.length,
        warnings: result.warnings.slice(0, 20),
        subject: result.template.subject ?? null,
      },
    });
  } catch (e: any) {
    json(res, 500, { error: e.message ?? String(e) });
  }
}

// ─── Reviewer surface (MIME_SURFACE=public_review) ─────────────────────────
//
// Public-facing deploy for external reviewers. Per-reviewer URL token sets a
// HttpOnly cookie; subsequent /api/r/* calls authenticate via the cookie.
// See plans/2026-05-26-reviewer-dashboard.md.

const REVIEWER_COOKIE = "reviewer_token";

function parseCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers["cookie"] ?? "";
  for (const part of String(header).split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) {
      return decodeURIComponent(part.slice(eq + 1));
    }
  }
  return null;
}

function setReviewerCookie(res: ServerResponse, token: string): void {
  // 1-year expiry, HttpOnly + SameSite=Lax. The public deploy may not
  // be on HTTPS during dev — Secure flag is set only when we can detect
  // HTTPS (Replit Autoscale terminates TLS and sets x-forwarded-proto).
  const cookie = [
    `${REVIEWER_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${60 * 60 * 24 * 365}`,
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ");
  res.setHeader("set-cookie", cookie);
}

async function requireReviewer(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<ReviewerRecord | null> {
  // Open access by design: anyone hitting the public surface gets a
  // synthetic "public" reviewer identity. If a real reviewer_token
  // cookie is present and resolves to a row, prefer that (so per-
  // reviewer scoping still works for any future use), otherwise
  // everyone shares the same public id and store list.
  const token = parseCookie(req, REVIEWER_COOKIE);
  if (token) {
    const reviewer = await getReviewerByToken(token);
    if (reviewer) return reviewer;
  }
  return PUBLIC_REVIEWER;
}

// Synthetic identity for non-cookie visitors. All public access shares
// this single id so stores created without a cookie are all owned by
// "public" and visible to anyone else who lands here.
const PUBLIC_REVIEWER: ReviewerRecord = {
  id: "public",
  name: "Reviewer",
  token: "",
  email: null,
  createdAt: new Date(0).toISOString(),
  disabledAt: null,
};

// GET /r/<token>/ — handshake. If the token matches a real reviewer row,
// set the cookie so future requests authenticate as that reviewer. If it
// doesn't, just redirect to /dashboard anyway — the public surface is
// open access, so an unrecognized token isn't an error, just an anonymous
// visitor.
async function handleReviewerHandshake(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
): Promise<void> {
  const reviewer = await getReviewerByToken(token);
  if (reviewer) setReviewerCookie(res, token);
  res.writeHead(302, { location: "/dashboard" });
  res.end();
}

// GET /api/r/me — minimum payload the dashboard needs to render a header.
async function handleReviewerMe(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;
  return json(res, 200, {
    reviewerId: reviewer.id,
    reviewerName: reviewer.name,
  });
}

// GET /api/r/stores — reviewer's own stores only.
async function handleReviewerStoresList(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;
  const recs = await listStoresForReviewer(reviewer.id);
  // Use the summary shape so masked keys + JWT expiry are exposed to the
  // dashboard without leaking raw secrets.
  return json(res, 200, { stores: recs.map(toSummary) });
}

// GET /api/r/stores/:id — reviewer's own store, full record (unmasked) so
// the edit form can populate. Ownership-checked.
async function handleReviewerStoreGet(
  req: IncomingMessage,
  res: ServerResponse,
  storeId: string,
): Promise<void> {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;
  const rec = await getStoreForReviewer(storeId, reviewer.id);
  if (!rec) return json(res, 404, { error: `store ${storeId} not found` });
  return json(res, 200, { store: rec });
}

// POST /api/r/stores — create a store owned by the current reviewer.
// Reviewer only supplies: name, klaviyoKey, redoJwt. The server derives:
//   - merchantSlug from name (kebab-case; appends random suffix on
//     collision with an existing slug)
//   - storeId from the redoJwt's aud/teamId/team_id/sub claim (same path
//     the admin uses via decodeJwtAud)
// Mirrors the admin's setup-modal "couldn't read store ID" hint by
// returning a 400 when the JWT can't be decoded.
async function handleReviewerStoreCreate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;
  if (!isDbEnabled()) return json(res, 503, { error: "DB not enabled" });
  const body = await readJsonBody(req);
  const name = String(body.name ?? "").trim();
  const klaviyoKey = String(body.klaviyoKey ?? "").trim();
  const redoJwt = body.redoJwt ? String(body.redoJwt).trim() : "";
  if (!name || !klaviyoKey || !redoJwt) {
    return json(res, 400, {
      error: "name, klaviyoKey, and redoJwt required",
    });
  }
  // Auto-extract storeId from the JWT (mongo ObjectId from aud/teamId/etc).
  const storeId = decodeJwtAud(redoJwt);
  if (!storeId) {
    return json(res, 400, {
      error: "Couldn't read your Redo store ID from the JWT — paste a fresh session token.",
    });
  }
  // Auto-derive merchantSlug from name. Falls back to a generic random
  // suffix on collision so two stores named "Acme" can coexist.
  const baseSlug = nameToSlug(name);
  let merchantSlug = baseSlug;
  for (let i = 0; i < 5; i++) {
    const existing = await getStoreBySlug(merchantSlug);
    if (!existing) break;
    merchantSlug = baseSlug + "-" + Math.random().toString(36).slice(2, 6);
  }
  try {
    const rec = await createStore({
      name,
      merchantSlug,
      klaviyoKey,
      redoJwt,
      storeId,
      redoServerBase: null,
      // Tag with reviewer id so listStoresForReviewer() filters to this
      // reviewer only. createdBy stays null since there's no admin user
      // associated with a reviewer-created store.
      createdByReviewer: reviewer.id,
    });
    return json(res, 201, { store: rec });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (msg.includes("idx_stores_slug") || msg.includes("duplicate key")) {
      return json(res, 409, { error: `merchantSlug "${merchantSlug}" already exists — try again` });
    }
    return json(res, 500, { error: msg });
  }
}

// Lowercase, hyphenate, drop non-alphanum/dash. Mirrors typical merchant-
// slug shapes used by the admin (acme-apparel, otishi-wellness, etc.).
function nameToSlug(name: string): string {
  const cleaned = name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "store";
}

// PATCH /api/r/stores/:id — edit a reviewer-owned store. Ownership-checked
// before the update runs.
async function handleReviewerStoreUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  storeId: string,
): Promise<void> {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;
  if (!isDbEnabled()) return json(res, 503, { error: "DB not enabled" });
  // Ownership gate: refuse to even read the body if this isn't the
  // reviewer's store.
  const existing = await getStoreForReviewer(storeId, reviewer.id);
  if (!existing) return json(res, 404, { error: `store ${storeId} not found` });
  const body = await readJsonBody(req);
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string") patch.name = body.name.trim();
  if (typeof body.merchantSlug === "string") patch.merchantSlug = body.merchantSlug.trim();
  if (typeof body.klaviyoKey === "string") patch.klaviyoKey = body.klaviyoKey.trim();
  if (typeof body.storeId === "string") patch.storeId = body.storeId.trim();
  if (typeof body.redoJwt === "string") patch.redoJwt = body.redoJwt.trim() || null;
  if (typeof body.redoServerBase === "string") {
    patch.redoServerBase = body.redoServerBase.trim() || null;
  }
  try {
    const rec = await updateStore(storeId, patch as any);
    if (!rec) return json(res, 404, { error: `store ${storeId} not found` });
    return json(res, 200, { store: rec });
  } catch (e: any) {
    return json(res, 500, { error: e.message ?? String(e) });
  }
}

// DELETE /api/r/stores/:id — scoped delete. Returns 404 (not 403) on
// ownership mismatch so we don't leak existence of other reviewers' stores.
async function handleReviewerStoreDelete(
  req: IncomingMessage,
  res: ServerResponse,
  storeId: string,
): Promise<void> {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;
  if (!isDbEnabled()) return json(res, 503, { error: "DB not enabled" });
  const ok = await deleteStoreForReviewer(storeId, reviewer.id);
  if (!ok) return json(res, 404, { error: `store ${storeId} not found` });
  return json(res, 200, { ok: true });
}

// ─── Phase 3: flow listing + import + job streaming ──────────────────────

// POST /api/r/stores/:id/flows — list Klaviyo flows for a reviewer-owned
// store. Reviewer never sees/sends the raw klaviyoKey; the server reads it
// from the store record. Mirrors handleFlowsList for the admin surface.
async function handleReviewerStoreFlowsList(
  req: IncomingMessage,
  res: ServerResponse,
  storeId: string,
): Promise<void> {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;
  const store = await getStoreForReviewer(storeId, reviewer.id);
  if (!store) return json(res, 404, { error: `store ${storeId} not found` });
  try {
    const flows = await paginate<FlowMeta>(
      "/flows/?fields[flow]=name,status,trigger_type&sort=-updated",
      store.klaviyoKey,
    );
    return json(res, 200, {
      flows: flows.map((f) => ({
        id: f.id,
        name: f.attributes.name,
        status: f.attributes.status,
        triggerType: f.attributes.trigger_type,
      })),
    });
  } catch (e: any) {
    return json(res, 500, { error: e.message ?? String(e) });
  }
}

// POST /api/r/stores/:id/templates — list Klaviyo templates for a
// reviewer-owned store. Mirrors handleTemplates' shape: paginates,
// filters out editor_type=KLAVIYO (legacy/visual builder we don't
// support), returns a slim metadata array.
async function handleReviewerStoreTemplatesList(
  req: IncomingMessage,
  res: ServerResponse,
  storeId: string,
): Promise<void> {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;
  const store = await getStoreForReviewer(storeId, reviewer.id);
  if (!store) return json(res, 404, { error: `store ${storeId} not found` });
  try {
    type T = {
      id: string;
      attributes: { name: string; editor_type: string; updated: string };
    };
    const all = await paginate<T>(
      "/templates/?fields[template]=name,editor_type,updated&sort=-updated",
      store.klaviyoKey,
    );
    const templates = all
      .filter((t) => t.attributes.editor_type !== "KLAVIYO")
      .map((t) => ({
        id: t.id,
        name: t.attributes.name,
        editorType: t.attributes.editor_type,
        updated: t.attributes.updated,
      }));
    return json(res, 200, { templates });
  } catch (e: any) {
    return json(res, 500, { error: e.message ?? String(e) });
  }
}

// POST /api/r/stores/:id/campaigns — list recent campaigns. Slim version
// of handleCampaigns: just returns campaign metadata for the picker; the
// import pipeline walks per-campaign messages internally when it imports.
// Cap at 20 most-recent (same rationale as admin: walking older campaigns
// blows past the proxy timeout).
async function handleReviewerStoreCampaignsList(
  req: IncomingMessage,
  res: ServerResponse,
  storeId: string,
): Promise<void> {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;
  const store = await getStoreForReviewer(storeId, reviewer.id);
  if (!store) return json(res, 404, { error: `store ${storeId} not found` });
  try {
    const filter = encodeURIComponent(`equals(messages.channel,"email")`);
    const body: any = await klaviyo(
      `/campaigns/?filter=${filter}&fields[campaign]=name,status,send_time,created_at&sort=-created_at&page[size]=20`,
      store.klaviyoKey,
    );
    const campaigns = ((body?.data ?? []) as any[]).map((c) => ({
      id: c.id,
      name: c.attributes?.name ?? c.id,
      status: c.attributes?.status ?? "unknown",
      sendTime: c.attributes?.send_time ?? null,
      createdAt: c.attributes?.created_at ?? null,
    }));
    return json(res, 200, { campaigns });
  } catch (e: any) {
    return json(res, 500, { error: e.message ?? String(e) });
  }
}

// POST /api/r/stores/:id/import — kick off an import job for one of the
// reviewer's stores. Body: { flowIds?, templateIds?, campaignIds? } — at
// least one non-empty. The server reuses the store's stored credentials
// so the reviewer can't import against keys they don't own. Mirrors
// handleJobCreate on the admin side.
async function handleReviewerImport(
  req: IncomingMessage,
  res: ServerResponse,
  storeId: string,
): Promise<void> {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;
  const store = await getStoreForReviewer(storeId, reviewer.id);
  if (!store) return json(res, 404, { error: `store ${storeId} not found` });
  if (!store.redoJwt) {
    return json(res, 400, {
      error: "store has no Redo JWT — edit the store and add one before importing",
    });
  }
  const body = await readJsonBody(req);
  const flowIds = Array.isArray(body.flowIds) ? (body.flowIds as string[]) : [];
  const templateIds = Array.isArray(body.templateIds) ? (body.templateIds as string[]) : [];
  const campaignIds = Array.isArray(body.campaignIds) ? (body.campaignIds as string[]) : [];
  if (flowIds.length + templateIds.length + campaignIds.length === 0) {
    return json(res, 400, {
      error: "pick at least one flow, template, or campaign to import",
    });
  }
  // Construct the run body from the store record. The reviewer can't
  // supply klaviyoKey/redoJwt/storeId — those come from the ownership-
  // checked store.
  const runBody = {
    klaviyoKey: store.klaviyoKey,
    storeId: store.storeId,
    merchantSlug: store.merchantSlug,
    flowIds,
    templateIds,
    campaignIds,
    redoJwt: store.redoJwt,
    redoServerBase: store.redoServerBase ?? undefined,
    runImport: true,
  };
  const params = parseRunBody(runBody);
  if ("error" in params) return json(res, 400, { error: params.error });

  const job = createJob({
    storeId: store.id,
    storeName: store.name,
    merchantSlug: store.merchantSlug,
    templateIds,
    flowIds,
  });
  const ctrl = jobController(job.id);

  json(res, 202, { jobId: job.id, status: job.status });

  setStatus(job.id, "running");
  void runImport(params, ctrl)
    .then((summary) => {
      setStatus(job.id, "completed", { summary });
    })
    .catch((e: any) => {
      ctrl.emit({
        kind: "error",
        severity: "error",
        text: e?.message ?? String(e),
      });
      setStatus(job.id, "failed", { error: e?.message ?? String(e) });
    });
}

// Ownership check for jobs. A job is owned by a reviewer iff the job's
// storeId (the Redo Mongo ObjectId in this codebase's terminology) matches
// a store the reviewer created. Cross-references job → store row.
async function getJobForReviewer(
  jobId: string,
  reviewerId: string,
): Promise<ReturnType<typeof getJob> | null> {
  const job = getJob(jobId);
  if (!job) return null;
  // job.storeId is the Redo store_id (mongo ObjectId), not the stores.id
  // primary key. The stores table has BOTH — id (primary) and store_id
  // (Redo's Mongo id). Reviewer ownership is by stores.id from the
  // reviewer's row. We need a way to find the local stores row whose
  // store_id matches job.storeId AND created_by_reviewer = reviewerId.
  // Simplest: list all the reviewer's stores and check membership.
  const myStores = await listStoresForReviewer(reviewerId);
  const ownsStore = myStores.some(
    (s) => s.storeId === job.storeId || s.id === job.storeId,
  );
  return ownsStore ? job : null;
}

// GET /api/r/jobs — list jobs across all the reviewer's stores. Each
// summary mirrors handleJobList's shape but trimmed to fields the
// reviewer dashboard needs.
async function handleReviewerJobsList(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;
  const myStores = await listStoresForReviewer(reviewer.id);
  const myStoreIds = new Set(myStores.flatMap((s) => [s.id, s.storeId]));
  const all = listJobs();
  const myJobs = all.filter((j) => myStoreIds.has(j.storeId));
  // Cross-process freshness: pull each owned job's notes column from DB so
  // any notes admin (or this reviewer on another tab) wrote land in the
  // sidebar's per-item textareas without a process restart.
  await Promise.all(myJobs.map((j) => refreshJobNotesFromDb(j.id)));
  const jobs = myJobs
    .map((j) => {
      // Derive per-item display info from the job events so the sidebar
      // can list "Flow X — imported" / "Template Y — failed" with the
      // reviewer's note. The admin's bundle.ts does the same walk.
      const items = collectItemsFromEvents(j);
      return {
        id: j.id,
        storeId: j.storeId,
        storeName: j.storeName,
        status: j.status,
        createdAt: j.createdAt,
        completedAt: j.completedAt,
        flowIds: j.flowIds,
        templateIds: j.templateIds,
        items, // [{ id, type, name, state, note }]
        eventCount: j.events.length,
        summary: j.summary,
        error: j.error,
        lastEvent: j.events[j.events.length - 1] ?? null,
        pendingInput: j.pendingInput ?? null,
      };
    });
  return json(res, 200, { jobs });
}

// Walk the event log to assemble per-item state. Each item is identified
// by its Klaviyo id; events name it via `id` + `name`. We pick the most
// recent state-transition event per id (exported/flow_imported/fail/etc.)
// to produce a final state for display.
function collectItemsFromEvents(j: ReturnType<typeof getJob>): Array<{
  id: string;
  type: "template" | "flow" | "campaign";
  name: string;
  state: "queued" | "imported" | "failed";
  note: string | null;
  noteAuthor: string | null;
}> {
  if (!j) return [];
  const byId = new Map<string, { id: string; type: "template" | "flow" | "campaign"; name: string; state: "queued" | "imported" | "failed" }>();
  for (const ev of j.events) {
    const p = ev.payload as any;
    if (!p || typeof p.id !== "string") continue;
    if (ev.kind === "exported") {
      byId.set(p.id, { id: p.id, type: "template", name: p.name ?? p.id, state: "imported" });
    } else if (ev.kind === "flow_imported") {
      byId.set(p.id, { id: p.id, type: "flow", name: p.name ?? p.id, state: "imported" });
    } else if (ev.kind === "imported") {
      // campaign-imported event uses kind="imported" per existing code
      const existing = byId.get(p.id);
      byId.set(p.id, {
        id: p.id,
        type: existing?.type ?? "campaign",
        name: p.name ?? existing?.name ?? p.id,
        state: "imported",
      });
    } else if (ev.kind === "fail") {
      // Preserve whatever type we'd already seen; fall back to flow.
      const existing = byId.get(p.id);
      byId.set(p.id, {
        id: p.id,
        type: existing?.type ?? "flow",
        name: p.name ?? existing?.name ?? p.id,
        state: "failed",
      });
    }
  }
  return Array.from(byId.values()).map((it) => {
    const raw = j.notes?.[it.id];
    let noteText: string | null = null;
    let noteAuthor: string | null = null;
    if (typeof raw === "string") {
      noteText = raw || null;
    } else if (raw && typeof raw === "object") {
      const r = raw as any;
      noteText = r.text ?? null;
      noteAuthor = r.author ?? null;
    }
    return { ...it, note: noteText, noteAuthor };
  });
}

// GET /api/r/jobs/:id — full job detail (ownership-checked).
async function handleReviewerJobGet(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
): Promise<void> {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;
  const job = await getJobForReviewer(jobId, reviewer.id);
  if (!job) return json(res, 404, { error: `job ${jobId} not found` });
  return json(res, 200, job);
}

// POST /api/r/jobs/:id/notes — upsert a per-item note for a reviewer-owned
// job. Body: { itemId: string, note: string }. Empty note clears the entry.
// Author is the reviewer's display name so admin's bundle download
// attributes correctly.
async function handleReviewerJobNotes(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
): Promise<void> {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;
  const job = await getJobForReviewer(jobId, reviewer.id);
  if (!job) return json(res, 404, { error: `job ${jobId} not found` });
  const body = await readJsonBody(req);
  const itemId = body.itemId;
  const note = body.note;
  if (typeof itemId !== "string" || typeof note !== "string") {
    return json(res, 400, { error: "itemId and note (string) required" });
  }
  const ok = setNote(jobId, itemId, note, reviewer.name);
  if (!ok) return json(res, 404, { error: `job ${jobId} not found` });
  return json(res, 200, { ok: true });
}

// POST /api/r/jobs/:id/inputs — deliver an answer to a needs_input prompt.
// Same shape as admin handleJobInput, but ownership-checked. Body must
// include { inputId, answer }.
async function handleReviewerJobInput(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
): Promise<void> {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;
  const job = await getJobForReviewer(jobId, reviewer.id);
  if (!job) return json(res, 404, { error: `job ${jobId} not found` });
  const body = await readJsonBody(req);
  const inputId = body.inputId as string | undefined;
  const answer = body.answer;
  if (!inputId || answer === undefined) {
    return json(res, 400, { error: "inputId and answer required" });
  }
  const result = resolveInput(jobId, inputId, String(answer));
  if (!result.ok) return json(res, 400, result);
  return json(res, 200, { ok: true });
}

// GET /api/r/jobs/:id/stream — NDJSON live stream (ownership-checked).
// Same logic as handleJobStream — replays history past ?since, subscribes
// for new events, heartbeats every 10s, ends on terminal status.
async function handleReviewerJobStream(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
): Promise<void> {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;
  const job = await getJobForReviewer(jobId, reviewer.id);
  if (!job) return json(res, 404, { error: `job ${jobId} not found` });

  const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
  const since = Number(url.searchParams.get("since") ?? "0");

  ndjsonStart(res);

  for (const e of job.events) {
    if (e.seq > since) res.write(JSON.stringify(e) + "\n");
  }

  const terminal = (status: string) =>
    status === "completed" || status === "failed" || status === "cancelled";
  if (terminal(job.status)) {
    res.end();
    return;
  }

  const unsubscribe = subscribe(jobId, (event) => {
    res.write(JSON.stringify(event) + "\n");
  });

  const interval = setInterval(() => {
    const current = getJob(jobId);
    if (!current || terminal(current.status)) {
      clearInterval(interval);
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    }
  }, 500);

  const heartbeat = setInterval(() => {
    res.write(JSON.stringify({ kind: "heartbeat", t: Date.now() }) + "\n");
  }, 10_000);

  req.on("close", () => {
    clearInterval(interval);
    clearInterval(heartbeat);
    unsubscribe();
  });
}

// Reviewer dashboard — Phase 2.
//
// Design matches the admin "Toby 2.0" shell (src/migrate/ui/index.html):
// same Instrument Serif headers, Inter body, color palette
// (#0d1117 / #010409 / #21262d / #30363d / #FF4405). Branding swap
// only: "Toby 2.0" → "mime / review" with the orange italic accent on
// "review". Fonts loaded from Google Fonts CDN so this surface has no
// dependency on local /fonts/ static assets.
//
// Vanilla JS (no Babel/React build) — the reviewer surface is small
// enough that a single inline script is simpler than wiring component
// files like the admin does.
const REVIEWER_DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>mime · review</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body, #root { height: 100%; background: #0d1117; }
    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      font-feature-settings: "ss01", "cv11";
      color: #e6edf3;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    .font-serif { font-family: 'Instrument Serif', 'Times New Roman', serif; letter-spacing: -0.005em; }
    *::-webkit-scrollbar { width: 10px; height: 10px; }
    *::-webkit-scrollbar-track { background: transparent; }
    *::-webkit-scrollbar-thumb { background: #21262d; border-radius: 5px; border: 2px solid #0d1117; }
    *::-webkit-scrollbar-thumb:hover { background: #30363d; }
    input:-webkit-autofill {
      -webkit-text-fill-color: #e6edf3 !important;
      -webkit-box-shadow: 0 0 0 1000px #010409 inset !important;
    }

    /* Layout shell — mirrors admin's h-screen / flex-col */
    .shell { height: 100vh; display: flex; flex-direction: column; }
    .body { display: flex; flex: 1; overflow: hidden; }
    main { flex: 1; overflow-y: auto; min-width: 0; }

    /* Right-side jobs panel — 1/4 of the viewport, mirrors admin's
       w-[400px] bg-[#010409] border-l rail. */
    .jobs-panel {
      width: 25%; min-width: 280px; max-width: 420px;
      border-left: 1px solid #21262d;
      background: #010409;
      display: flex; flex-direction: column;
      overflow: hidden;
    }
    .jobs-header {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 14px; border-bottom: 1px solid #21262d;
    }
    .jobs-header .label {
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
      color: #e6edf3;
    }
    .jobs-header .total {
      margin-left: auto; font-size: 11px; color: #6e7681;
      font-variant-numeric: tabular-nums;
    }
    .jobs-list { flex: 1; overflow-y: auto; }
    .jobs-empty {
      padding: 32px 16px; text-align: center;
      color: #484f58; font-size: 11px; line-height: 1.6;
    }
    .job-card {
      border-bottom: 1px solid #161b22; padding: 10px 14px;
      cursor: pointer;
    }
    .job-card:hover { background: #0d1117; }
    .job-card .row1 { display: flex; align-items: center; gap: 6px; }
    .job-card .dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
    .job-card .dot.running { background: #58a6ff; animation: pulse 1.5s ease-in-out infinite; }
    .job-card .dot.completed { background: #3fb950; }
    .job-card .dot.failed { background: #f85149; }
    .job-card .dot.awaiting_input { background: #d29922; animation: pulse 1.5s ease-in-out infinite; }
    .job-card .dot.partial { background: #d29922; }
    /* Use a job-card-specific name; the .store class is already used by
       the main grid store cards (display:flex, min-height:110) and
       would otherwise apply those rules to the inline span here. */
    .job-card .store-name { font-family: 'Instrument Serif', serif; font-size: 15px; color: #e6edf3; line-height: 1.1; min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .job-card .when { margin-left: auto; font-size: 10px; color: #6e7681; flex-shrink: 0; }
    .job-card .stats { font-size: 11px; color: #8b949e; margin-top: 4px; }
    .job-items {
      background: #0d1117; padding: 8px 14px 12px;
      border-bottom: 1px solid #161b22;
    }
    .job-item {
      padding: 8px 0; border-bottom: 1px dashed #21262d;
    }
    .job-item:last-child { border-bottom: 0; }
    .job-item .head { display: flex; align-items: center; gap: 6px; }
    .job-item .kind {
      font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em;
      padding: 1px 5px; border-radius: 3px; flex-shrink: 0;
    }
    .job-item .kind.flow { background: #1c2b4a; color: #79c0ff; }
    .job-item .kind.template { background: #2d2418; color: #d29922; }
    .job-item .kind.campaign { background: #1b4721; color: #3fb950; }
    .job-item .name {
      font-size: 12px; color: #e6edf3; flex: 1;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
    }
    .job-item .state {
      font-size: 9px; color: #6e7681; text-transform: uppercase; letter-spacing: 0.05em;
      flex-shrink: 0;
    }
    .job-item .state.failed { color: #f85149; }
    .job-item .state.imported { color: #3fb950; }
    .job-item textarea {
      width: 100%; background: #010409; border: 1px solid #21262d;
      color: #e6edf3; padding: 6px 8px; border-radius: 4px;
      font: inherit; font-size: 11px; line-height: 1.4;
      margin-top: 6px; resize: vertical; min-height: 32px;
    }
    .job-item textarea:focus { outline: none; border-color: #58a6ff; }
    .job-item textarea::placeholder { color: #484f58; }
    .job-item .note-status {
      font-size: 10px; color: #6e7681; margin-top: 3px;
      display: flex; align-items: center; gap: 6px;
    }
    .job-item .note-status .saved { color: #3fb950; }
    .job-item .note-status .saving { color: #58a6ff; }

    /* Top bar — mirrors admin's bg-[#010409] border-b border-[#21262d] */
    .topbar {
      display: flex; align-items: center; gap: 12px;
      padding: 8px 16px;
      border-bottom: 1px solid #21262d;
      background: #010409;
    }
    .brand { display: flex; align-items: baseline; gap: 8px; }
    .brand .mime { font-family: 'Instrument Serif', serif; font-size: 22px; line-height: 1; color: #e6edf3; }
    .brand .review { font-family: 'Instrument Serif', serif; font-style: italic; font-size: 16px; line-height: 1; color: #FF4405; }
    .brand .subbrand { font-size: 11px; color: #6e7681; margin-left: 4px; }
    .badge {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
      color: #6e7681; padding: 2px 8px; border: 1px solid #30363d;
      border-radius: 3px; margin-left: 8px;
    }
    .topbar .who { font-size: 12px; color: #6e7681; margin-left: auto; display: flex; align-items: center; gap: 8px; }
    .topbar .who-name { color: #e6edf3; }
    .signout {
      font-size: 11px; color: #6e7681; background: transparent;
      border: 1px solid #30363d; padding: 3px 10px; border-radius: 4px;
      cursor: pointer; transition: color 0.15s, border-color 0.15s;
    }
    .signout:hover { color: #e6edf3; border-color: #388bfd; }

    /* Main content */
    main { flex: 1; overflow-y: auto; }
    .container { max-width: 1200px; margin: 0 auto; padding: 32px; }
    .heading-row { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 24px; }
    h1 { font-family: 'Instrument Serif', serif; font-size: 40px; line-height: 1; letter-spacing: -0.025em; font-weight: 400; }
    .subtitle { font-size: 12px; color: #8b949e; margin-top: 8px; }

    /* Store cards */
    .stores-grid {
      display: grid; grid-template-columns: repeat(1, minmax(0, 1fr)); gap: 12px;
    }
    @media (min-width: 768px)  { .stores-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (min-width: 1024px) { .stores-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    .store {
      text-align: left; border: 1px solid #21262d; border-radius: 6px;
      padding: 16px; background: #0d1117; cursor: pointer;
      transition: border-color 0.15s; min-height: 110px;
      display: flex; flex-direction: column;
    }
    .store:hover { border-color: #30363d; }
    .store .row { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
    .store .col { min-width: 0; }
    .store .name { font-family: 'Instrument Serif', serif; font-size: 22px; line-height: 1.1; color: #e6edf3;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .store .slug { font-size: 11px; color: #6e7681; margin-top: 4px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .store .chevron { color: #6e7681; flex-shrink: 0; }
    .store .meta { font-size: 11px; color: #8b949e; }
    .store .meta.warn { color: #d29922; }

    .add-store {
      border: 1px dashed #30363d; border-radius: 6px; padding: 16px;
      background: transparent; color: #8b949e; cursor: pointer;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 4px; min-height: 110px;
      transition: color 0.15s, border-color 0.15s;
    }
    .add-store:hover { border-color: #388bfd; color: #e6edf3; }
    .add-store .plus { font-size: 18px; line-height: 1; }
    .add-store .label { font-size: 12px; }

    /* Empty state — when reviewer has no stores yet */
    .empty {
      text-align: center; padding: 80px 24px; max-width: 480px; margin: 0 auto;
    }
    .empty .icon { font-family: 'Instrument Serif', serif; font-size: 48px; color: #6e7681; margin-bottom: 16px; }
    .empty h2 { font-family: 'Instrument Serif', serif; font-size: 28px; line-height: 1; margin-bottom: 12px; font-weight: 400; }
    .empty p { font-size: 13px; color: #8b949e; line-height: 1.6; margin-bottom: 24px; }
    .empty .cta {
      background: #238636; color: white; border: 1px solid #238636;
      padding: 8px 18px; border-radius: 4px; font-size: 13px;
      font-family: inherit; cursor: pointer; transition: background 0.15s;
    }
    .empty .cta:hover { background: #2ea043; }

    /* Modal */
    .scrim {
      position: fixed; inset: 0;
      background: #010409cc; backdrop-filter: blur(4px);
      display: none; align-items: flex-start; justify-content: center;
      padding-top: 80px; z-index: 50;
    }
    .scrim.open { display: flex; }
    .modal {
      background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
      width: 480px; max-width: calc(100vw - 32px); padding: 24px;
      box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
    }
    .modal h2 {
      font-family: 'Instrument Serif', serif; font-size: 24px; line-height: 1;
      margin-bottom: 6px; font-weight: 400;
    }
    .modal .modal-subtitle { font-size: 12px; color: #8b949e; margin-bottom: 20px; }
    .modal label { display: block; font-size: 11px; color: #8b949e; margin: 12px 0 4px;
      text-transform: uppercase; letter-spacing: 0.05em; font-weight: 500; }
    .modal input {
      width: 100%; background: #010409; border: 1px solid #30363d;
      color: #e6edf3; padding: 8px 10px; border-radius: 4px;
      font: inherit; font-size: 13px;
      transition: border-color 0.15s;
    }
    .modal input:focus { outline: none; border-color: #388bfd; }
    .modal input::placeholder { color: #484f58; }
    .hint { color: #6e7681; font-size: 11px; margin-top: 4px; }
    .modal-row {
      display: flex; gap: 10px; margin-top: 20px; justify-content: flex-end;
      padding-top: 16px; border-top: 1px solid #21262d;
    }
    .btn {
      padding: 7px 14px; border-radius: 4px; font-size: 13px;
      font-family: inherit; cursor: pointer;
      border: 1px solid #30363d; background: transparent; color: #e6edf3;
      transition: background 0.15s, border-color 0.15s;
    }
    .btn:hover { background: #161b22; }
    .btn.primary {
      background: #238636; border-color: #238636; color: white;
    }
    .btn.primary:hover { background: #2ea043; border-color: #2ea043; }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .err { color: #f78166; font-size: 12px; margin-top: 12px; }

    /* Store-detail view */
    .breadcrumb {
      display: flex; align-items: center; gap: 6px; font-size: 12px; color: #6e7681;
      margin-bottom: 16px;
    }
    .breadcrumb a { color: #58a6ff; cursor: pointer; }
    .breadcrumb a:hover { color: #79c0ff; }
    .breadcrumb .sep { color: #30363d; }

    .flows-toolbar {
      display: flex; align-items: center; gap: 12px;
      padding: 12px 16px; background: #010409; border: 1px solid #21262d;
      border-radius: 6px; margin-bottom: 12px; position: sticky; top: 0; z-index: 1;
    }
    .flows-toolbar .count { font-size: 12px; color: #8b949e; }
    .flows-toolbar .count strong { color: #e6edf3; }
    .flows-toolbar .right { margin-left: auto; display: flex; gap: 8px; align-items: center; }
    .flows-toolbar input[type=search] {
      background: #0d1117; border: 1px solid #30363d; color: #e6edf3;
      padding: 5px 10px; border-radius: 4px; font: inherit; font-size: 12px;
      width: 200px;
    }
    .flows-toolbar input[type=search]:focus { outline: none; border-color: #388bfd; }
    .link-btn {
      background: transparent; border: 0; color: #58a6ff; cursor: pointer;
      font: inherit; font-size: 12px; padding: 0;
    }
    .link-btn:hover { color: #79c0ff; }

    .flow-list {
      border: 1px solid #21262d; border-radius: 6px; overflow: hidden;
      background: #0d1117;
    }
    .flow-row {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 14px; border-bottom: 1px solid #161b22;
      cursor: pointer; transition: background 0.1s;
    }
    .flow-row:last-child { border-bottom: 0; }
    .flow-row:hover { background: #161b22; }
    .flow-row input[type=checkbox] {
      accent-color: #238636; width: 14px; height: 14px; cursor: pointer;
    }
    .flow-row .name { flex: 1; font-size: 13px; color: #e6edf3; }
    .flow-row .meta { font-size: 11px; color: #6e7681; display: flex; gap: 8px; align-items: center; }
    .flow-row .status { padding: 1px 6px; border-radius: 3px; font-size: 10px;
      text-transform: uppercase; letter-spacing: 0.05em; }
    .flow-row .status.live { background: #1b4721; color: #3fb950; }
    .flow-row .status.draft { background: #2d2418; color: #d29922; }
    .flow-row .status.archived { background: #21262d; color: #8b949e; }
    .flow-row .status.sent { background: #1b4721; color: #3fb950; }
    .flow-row .status.scheduled { background: #1c2b4a; color: #79c0ff; }
    .flow-row .status.cancelled { background: #21262d; color: #8b949e; }

    /* Tab bar — Flows | Templates | Campaigns */
    .tabs {
      display: flex; gap: 0; border-bottom: 1px solid #21262d;
      margin-bottom: 16px;
    }
    .tab {
      background: transparent; border: 0; padding: 10px 16px;
      font: inherit; font-size: 13px; color: #8b949e; cursor: pointer;
      border-bottom: 2px solid transparent; margin-bottom: -1px;
      display: flex; align-items: center; gap: 8px;
    }
    .tab:hover { color: #e6edf3; }
    .tab.active { color: #e6edf3; border-bottom-color: #FF4405; }
    .tab .count {
      background: #21262d; color: #8b949e; font-size: 10px;
      padding: 1px 6px; border-radius: 8px;
    }
    .tab.active .count { background: #2d1810; color: #FF8557; }

    /* Job progress view */
    .progress-card {
      border: 1px solid #21262d; border-radius: 6px; background: #0d1117;
      padding: 20px; margin-bottom: 16px;
    }
    .progress-status {
      display: flex; align-items: center; gap: 10px; margin-bottom: 12px;
    }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; }
    .status-dot.running { background: #58a6ff; animation: pulse 1.5s ease-in-out infinite; }
    .status-dot.completed { background: #3fb950; }
    .status-dot.failed { background: #f85149; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .progress-status .label {
      font-family: 'Instrument Serif', serif; font-size: 20px; line-height: 1;
    }
    .progress-meta { font-size: 12px; color: #8b949e; }
    .log {
      background: #010409; border: 1px solid #21262d; border-radius: 6px;
      padding: 12px 14px; font-family: 'SF Mono', Monaco, Consolas, monospace;
      font-size: 11px; line-height: 1.5; color: #8b949e;
      max-height: 400px; overflow-y: auto;
    }
    .log .line { white-space: pre-wrap; word-break: break-word; }
    .log .line.step { color: #79c0ff; }
    .log .line.info { color: #8b949e; }
    .log .line.warn { color: #d29922; }
    .log .line.err  { color: #f78166; }
    .log .line.success { color: #3fb950; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="topbar">
      <div class="brand">
        <span class="mime">mime</span>
        <span class="review">review</span>
        <span class="subbrand">· Klaviyo → Redo</span>
      </div>
      <span class="badge">open access</span>
      <div class="who">
        <span id="who-name" class="who-name">…</span>
      </div>
    </div>

    <div class="body">
      <main>
        <div class="container" id="container">
          <!-- Rendered by JS based on state.view: "stores" | "store" | "job" -->
        </div>
      </main>

      <!-- Right-side jobs panel: always visible. Lists all reviewer
           jobs; expand a job to see its imported items with note inputs.
           Notes are written to the same jobs.notes column the admin's
           bundle download reads from. -->
      <aside class="jobs-panel">
        <div class="jobs-header">
          <span class="label">Jobs</span>
          <span class="total" id="jobs-total">…</span>
        </div>
        <div class="jobs-list" id="jobs-list">
          <div class="jobs-empty">Loading…</div>
        </div>
      </aside>
    </div>
  </div>

  <!-- Needs-input modal — copies the admin's needs-input.jsx UX:
       header with "job paused" tag, item context, prominent question,
       italic clarifying context, type-specific input (boolean buttons /
       choice list / text input), "Apply to other items" checkbox, and
       a Skip option. JS builds the body dynamically per event. -->
  <div class="scrim" id="ni-scrim">
    <div class="modal" id="ni-modal" style="border-color:#58a6ff80;padding:0;width:520px">
      <div style="display:flex;align-items:center;gap:8px;border-bottom:1px solid #21262d;padding:14px 20px">
        <span style="width:6px;height:6px;border-radius:50%;background:#58a6ff;flex-shrink:0"></span>
        <h2 style="font-family:'Instrument Serif',serif;font-size:20px;line-height:1;color:#e6edf3;font-weight:400;margin:0">Needs your input</h2>
        <span style="font-size:11px;color:#6e7681;margin-left:auto">job paused</span>
      </div>
      <div style="padding:16px 20px 8px">
        <div style="font-size:11px;color:#6e7681;margin-bottom:6px" id="ni-meta"></div>
        <div style="font-size:14px;color:#e6edf3;margin-bottom:10px;line-height:1.5" id="ni-question"></div>
        <div style="font-size:11px;color:#8b949e;line-height:1.5;font-style:italic;border-left:2px solid #30363d;padding-left:8px;margin-bottom:16px;display:none" id="ni-context"></div>
        <div id="ni-input-wrap"></div>
        <label style="display:none;align-items:center;gap:6px;margin-top:14px;font-size:11px;color:#8b949e;cursor:pointer" id="ni-apply-all-wrap">
          <input type="checkbox" id="ni-apply-all" checked style="width:12px;height:12px;accent-color:#58a6ff;cursor:pointer" />
          Apply to other items with the same question
        </label>
        <div class="err" id="ni-err"></div>
      </div>
      <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:10px 20px;border-top:1px solid #21262d;background:#010409">
        <button id="ni-skip" style="font-size:11px;color:#8b949e;background:transparent;border:0;padding:6px 12px;cursor:pointer">Skip this item</button>
      </div>
    </div>
  </div>

  <div class="scrim" id="scrim">
    <div class="modal">
      <h2>Add store</h2>
      <div class="modal-subtitle">Three things — the rest is auto-detected.</div>

      <label>Store name</label>
      <input id="f-name" placeholder="Acme Apparel" autocomplete="off" />

      <label>Klaviyo API key</label>
      <input id="f-klav" type="password" placeholder="pk_..." autocomplete="off" />

      <label>Redo session JWT</label>
      <input id="f-jwt" type="password" placeholder="eyJ..." autocomplete="off" />
      <div class="hint">Your store ID is read from the JWT — no need to enter it separately.</div>

      <div class="err" id="err"></div>
      <div class="modal-row">
        <button class="btn" id="cancel">Cancel</button>
        <button class="btn primary" id="save">Add store</button>
      </div>
    </div>
  </div>

  <script>
    const $ = (id) => document.getElementById(id);

    // ─── Top-level app state ────────────────────────────────────────────
    // view: "stores" | "store" | "job"
    // store: cached current store record on the store/job views
    // flows: cached flow list per store id
    // selected: Set<flowId> for the picker
    // jobId/jobStatus/jobEvents: when view==="job"
    const state = {
      view: "stores",
      stores: null,
      store: null,
      // tab is which picker is currently shown
      tab: "flows", // "flows" | "templates" | "campaigns"
      // Loaded item lists per kind. null = not loaded yet, [] = empty list.
      items: { flows: null, templates: null, campaigns: null },
      // Per-kind selection sets. Persist across tab switches so the user
      // can pick a mix and import them all at once.
      selected: { flows: new Set(), templates: new Set(), campaigns: new Set() },
      filter: "",
      jobId: null,
      jobStatus: null,
      jobEvents: [],
      activeStream: null,
    };

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      })[c]);
    }

    function jwtRelative(iso) {
      const ms = new Date(iso).getTime() - Date.now();
      if (ms <= 0) return "expired";
      const mins = Math.floor(ms / 60000);
      if (mins < 60) return "expires in " + mins + "m";
      const hrs = Math.floor(mins / 60);
      if (hrs < 48) return "expires in " + hrs + "h";
      const days = Math.floor(hrs / 24);
      return "expires in " + days + "d";
    }

    // ─── Auth ───────────────────────────────────────────────────────────
    async function loadMe() {
      const r = await fetch("/api/r/me", { credentials: "same-origin" });
      if (!r.ok) {
        $("who-name").textContent = "Not signed in";
        return null;
      }
      const me = await r.json();
      $("who-name").textContent = me.reviewerName;
      return me;
    }

    // ─── Router / view dispatcher ──────────────────────────────────────
    // URL hash drives the view so refresh / bookmark works.
    //   #stores               → stores list (default)
    //   #store=<id>           → store detail (flow picker)
    //   #job=<jobId>          → job progress
    function parseHash() {
      const h = (location.hash || "").replace(/^#/, "");
      if (!h) return { view: "stores" };
      const [key, val] = h.split("=");
      if (key === "store" && val) return { view: "store", storeId: val };
      if (key === "job" && val)   return { view: "job", jobId: val };
      return { view: "stores" };
    }
    function setHash(view, id) {
      if (view === "stores") history.replaceState(null, "", "#stores");
      else if (view === "store") history.replaceState(null, "", "#store=" + id);
      else if (view === "job") history.replaceState(null, "", "#job=" + id);
    }
    async function routeFromHash() {
      const r = parseHash();
      if (r.view === "stores") return renderStoresView();
      if (r.view === "store") return openStore(r.storeId);
      if (r.view === "job") return openJob(r.jobId);
    }

    // ─── Stores view ────────────────────────────────────────────────────
    async function renderStoresView() {
      state.view = "stores";
      setHash("stores");
      // Abort any active stream from a previous view.
      if (state.activeStream) { state.activeStream.abort(); state.activeStream = null; }

      $("container").innerHTML =
        '<div class="heading-row">' +
          '<div>' +
            '<h1>Your stores</h1>' +
            '<div class="subtitle" id="subtitle">Loading…</div>' +
          '</div>' +
        '</div>' +
        '<div id="stores-wrap"></div>';

      const r = await fetch("/api/r/stores", { credentials: "same-origin" });
      if (!r.ok) {
        $("stores-wrap").innerHTML = '<p style="color:#f78166;font-size:13px">Failed to load stores (' + r.status + ').</p>';
        return;
      }
      const { stores } = await r.json();
      state.stores = stores;
      renderStoresGrid(stores);
    }

    function renderStoresGrid(stores) {
      $("subtitle").textContent =
        stores.length === 0
          ? "no stores yet"
          : stores.length + " store" + (stores.length === 1 ? "" : "s") + " · click one to pick flows to import";

      if (stores.length === 0) {
        $("stores-wrap").innerHTML =
          '<div class="empty">' +
            '<div class="icon">+</div>' +
            '<h2>Add your first store</h2>' +
            '<p>Connect a Klaviyo account and a Redo store, then pick which flows you want to migrate.</p>' +
            '<button class="cta" onclick="openModal()">Add store</button>' +
          '</div>';
        return;
      }

      const cards = stores.map((s) => {
        const jwtBadge = s.hasRedoJwt
          ? ('<div class="meta">JWT ' + (s.jwtExpiresAt ? escapeHtml(jwtRelative(s.jwtExpiresAt)) : "set") + '</div>')
          : '<div class="meta warn">No Redo JWT — add to import</div>';
        return (
          '<button class="store" data-id="' + escapeHtml(s.id) + '" onclick="openStore(\\'' + escapeHtml(s.id) + '\\')">' +
            '<div class="row">' +
              '<div class="col">' +
                '<div class="name">' + escapeHtml(s.name) + '</div>' +
                '<div class="slug">' + escapeHtml(s.merchantSlug) + '</div>' +
              '</div>' +
              '<svg class="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">' +
                '<path d="M6 4L10 8L6 12" stroke-linecap="round" stroke-linejoin="round"></path>' +
              '</svg>' +
            '</div>' +
            jwtBadge +
          '</button>'
        );
      }).join("");
      const addCard =
        '<button class="add-store" onclick="openModal()">' +
          '<span class="plus">+</span>' +
          '<span class="label">Add store</span>' +
        '</button>';
      $("stores-wrap").innerHTML = '<div class="stores-grid">' + cards + addCard + '</div>';
    }

    // ─── Store-detail view (multi-tab picker) ──────────────────────────
    // Renders 3 tabs (Flows | Templates | Campaigns). Each tab loads its
    // list on first click; selections persist across tab switches. The
    // single Import button submits the union across all three.
    async function openStore(storeId) {
      state.view = "store";
      state.tab = "flows";
      state.filter = "";
      state.items = { flows: null, templates: null, campaigns: null };
      state.selected = { flows: new Set(), templates: new Set(), campaigns: new Set() };
      setHash("store", storeId);
      if (state.activeStream) { state.activeStream.abort(); state.activeStream = null; }

      $("container").innerHTML =
        '<div class="breadcrumb">' +
          '<a onclick="renderStoresView()">← Your stores</a>' +
          '<span class="sep">/</span>' +
          '<span id="bc-name">…</span>' +
        '</div>' +
        '<div class="heading-row">' +
          '<div>' +
            '<h1 id="store-name">…</h1>' +
            '<div class="subtitle" id="store-subtitle">Loading…</div>' +
          '</div>' +
        '</div>' +
        '<div id="tabs"></div>' +
        '<div id="picker-toolbar"></div>' +
        '<div id="picker-wrap"></div>';

      const storeRes = await fetch(
        "/api/r/stores/" + encodeURIComponent(storeId),
        { credentials: "same-origin" },
      );
      if (!storeRes.ok) {
        $("picker-wrap").innerHTML = '<p style="color:#f78166;font-size:13px">Store not found.</p>';
        return;
      }
      const { store } = await storeRes.json();
      state.store = store;
      $("bc-name").textContent = store.name;
      $("store-name").textContent = store.name;
      $("store-subtitle").textContent = "Pick flows, templates, or campaigns to import";

      renderTabs();
      switchTab("flows");
    }

    function renderTabs() {
      const counts = {
        flows: state.items.flows ? state.items.flows.length : "…",
        templates: state.items.templates ? state.items.templates.length : "…",
        campaigns: state.items.campaigns ? state.items.campaigns.length : "…",
      };
      const tab = (key, label) => {
        const active = state.tab === key ? "active" : "";
        const sel = state.selected[key].size;
        const countLabel = sel > 0 ? sel + "/" + counts[key] : String(counts[key]);
        return '<button class="tab ' + active + '" onclick="switchTab(\\'' + key + '\\')">' +
          escapeHtml(label) +
          '<span class="count">' + countLabel + '</span>' +
          '</button>';
      };
      $("tabs").innerHTML =
        '<div class="tabs">' +
          tab("flows", "Flows") +
          tab("templates", "Templates") +
          tab("campaigns", "Campaigns") +
        '</div>';
    }

    async function switchTab(kind) {
      state.tab = kind;
      state.filter = "";
      renderTabs();
      if (state.items[kind] === null) {
        $("picker-toolbar").innerHTML = "";
        $("picker-wrap").innerHTML = '<div style="padding:24px;text-align:center;color:#6e7681;font-size:12px">Loading ' + kind + '…</div>';
        const r = await fetch(
          "/api/r/stores/" + encodeURIComponent(state.store.id) + "/" + kind,
          { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" },
        );
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          $("picker-wrap").innerHTML = '<p style="color:#f78166;font-size:13px">' +
            escapeHtml(err.error || ("Failed to load " + kind + " (" + r.status + ")")) +
            '</p>';
          state.items[kind] = [];
          renderTabs();
          return;
        }
        const data = await r.json();
        state.items[kind] = data[kind] || [];
        renderTabs();
      }
      renderPicker();
    }

    function renderPicker() {
      const kind = state.tab;
      const items = state.items[kind] || [];
      const filter = state.filter.toLowerCase().trim();
      const visible = filter
        ? items.filter((i) => (i.name || "").toLowerCase().includes(filter))
        : items;
      const sel = state.selected[kind];
      const totalSelected = state.selected.flows.size + state.selected.templates.size + state.selected.campaigns.size;
      const allVisibleSelected = visible.length > 0 && visible.every((i) => sel.has(i.id));
      const canImport = totalSelected > 0 && state.store && state.store.redoJwt;

      $("picker-toolbar").innerHTML =
        '<div class="flows-toolbar">' +
          '<div class="count"><strong>' + sel.size + '</strong> in this tab · <strong>' + totalSelected + '</strong> total · <strong>' + items.length + '</strong> available</div>' +
          '<button class="link-btn" onclick="selectAllVisible(' + (!allVisibleSelected) + ')">' +
            (allVisibleSelected ? 'Deselect all' : 'Select all visible') +
          '</button>' +
          '<div class="right">' +
            '<input type="search" placeholder="Filter by name…" id="picker-filter" value="' + escapeHtml(state.filter) + '" />' +
            '<button class="btn primary" id="import-btn" ' + (canImport ? '' : 'disabled') + ' onclick="runImport()">' +
              'Import ' + totalSelected + ' item' + (totalSelected === 1 ? '' : 's') +
            '</button>' +
          '</div>' +
        '</div>';

      const banner = !state.store.redoJwt
        ? '<div style="padding:14px;background:#2d2418;border:1px solid #6e5a23;border-radius:6px;color:#d29922;font-size:12px;margin-bottom:12px">This store has no Redo JWT yet. Browse here, but add a JWT before importing.</div>'
        : '';
      $("picker-wrap").innerHTML = banner + renderPickerRows(kind, visible);

      const fi = $("picker-filter");
      if (fi) {
        fi.oninput = (e) => {
          state.filter = e.target.value;
          renderPicker();
          $("picker-filter").focus();
          const len = $("picker-filter").value.length;
          $("picker-filter").setSelectionRange(len, len);
        };
      }
    }

    function renderPickerRows(kind, items) {
      if (items.length === 0) {
        return '<div style="padding:24px;text-align:center;color:#6e7681;font-size:12px;border:1px solid #21262d;border-radius:6px">' +
          (state.filter ? 'No items match the filter.' : 'No ' + kind + ' found.') +
          '</div>';
      }
      const sel = state.selected[kind];
      return '<div class="flow-list">' + items.map((i) => {
        const checked = sel.has(i.id) ? "checked" : "";
        const metaHtml = renderItemMeta(kind, i);
        return (
          '<label class="flow-row">' +
            '<input type="checkbox" ' + checked + ' onchange="toggleItem(\\'' + escapeHtml(i.id) + '\\', this.checked)" />' +
            '<div class="name">' + escapeHtml(i.name || i.id) + '</div>' +
            '<div class="meta">' + metaHtml + '</div>' +
          '</label>'
        );
      }).join("") + '</div>';
    }

    function renderItemMeta(kind, item) {
      if (kind === "flows") {
        const statusClass = item.status === "live" ? "live"
          : item.status === "draft" ? "draft"
          : "archived";
        return (
          '<span>' + escapeHtml(item.triggerType || "?") + '</span>' +
          '<span class="status ' + statusClass + '">' + escapeHtml(item.status || "") + '</span>'
        );
      }
      if (kind === "templates") {
        const ago = item.updated ? niceDate(item.updated) : "";
        return (
          '<span>' + escapeHtml(item.editorType || "") + '</span>' +
          (ago ? '<span>' + escapeHtml(ago) + '</span>' : '')
        );
      }
      if (kind === "campaigns") {
        const date = item.sendTime || item.createdAt;
        const status = String(item.status || "");
        const statusClass = /sent/i.test(status) ? "sent"
          : /scheduled/i.test(status) ? "scheduled"
          : /cancel/i.test(status) ? "cancelled"
          : "draft";
        return (
          (date ? '<span>' + escapeHtml(niceDate(date)) + '</span>' : '') +
          '<span class="status ' + statusClass + '">' + escapeHtml(status) + '</span>'
        );
      }
      return "";
    }

    function niceDate(iso) {
      try {
        return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      } catch (_) { return iso; }
    }

    function toggleItem(id, checked) {
      const sel = state.selected[state.tab];
      if (checked) sel.add(id); else sel.delete(id);
      const wasFocused = document.activeElement === $("picker-filter");
      renderTabs();
      renderPicker();
      if (wasFocused && $("picker-filter")) $("picker-filter").focus();
    }

    function selectAllVisible(yes) {
      const items = state.items[state.tab] || [];
      const filter = state.filter.toLowerCase().trim();
      const visible = filter ? items.filter((i) => (i.name || "").toLowerCase().includes(filter)) : items;
      const sel = state.selected[state.tab];
      if (yes) visible.forEach((i) => sel.add(i.id));
      else visible.forEach((i) => sel.delete(i.id));
      renderTabs();
      renderPicker();
    }

    // ─── Import + job streaming ────────────────────────────────────────
    async function runImport() {
      const flowIds = Array.from(state.selected.flows);
      const templateIds = Array.from(state.selected.templates);
      const campaignIds = Array.from(state.selected.campaigns);
      if (flowIds.length + templateIds.length + campaignIds.length === 0) return;
      const r = await fetch("/api/r/stores/" + encodeURIComponent(state.store.id) + "/import", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flowIds, templateIds, campaignIds }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(data.error || ("Import failed: " + r.status));
        return;
      }
      // Refresh the sidebar so the new job appears immediately.
      if (typeof loadJobs === "function") loadJobs();
      openJob(data.jobId);
    }

    async function openJob(jobId) {
      state.view = "job";
      state.jobId = jobId;
      state.jobEvents = [];
      state.jobStatus = "running";
      setHash("job", jobId);

      $("container").innerHTML =
        '<div class="breadcrumb">' +
          '<a onclick="renderStoresView()">← Your stores</a>' +
          (state.store ? '<span class="sep">/</span><a onclick="openStore(\\'' + escapeHtml(state.store.id) + '\\')">' + escapeHtml(state.store.name) + '</a>' : '') +
          '<span class="sep">/</span>' +
          '<span>Import</span>' +
        '</div>' +
        '<div class="progress-card">' +
          '<div class="progress-status">' +
            '<span class="status-dot running" id="status-dot"></span>' +
            '<span class="label" id="status-label">Importing…</span>' +
          '</div>' +
          '<div class="progress-meta" id="status-meta">Job ' + escapeHtml(jobId) + '</div>' +
        '</div>' +
        '<div class="log" id="log"></div>';

      // Stream the NDJSON.
      const ctrl = new AbortController();
      state.activeStream = ctrl;
      try {
        const resp = await fetch("/api/r/jobs/" + encodeURIComponent(jobId) + "/stream", {
          credentials: "same-origin",
          signal: ctrl.signal,
        });
        if (!resp.ok || !resp.body) {
          appendLog({ kind: "error", text: "Stream failed: " + resp.status }, "err");
          return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try { handleStreamEvent(JSON.parse(line)); }
            catch (_) { /* ignore parse errors */ }
          }
        }
        // Server ended the stream — job is terminal.
        finishJob();
      } catch (e) {
        if (e && e.name === "AbortError") return;
        appendLog({ kind: "error", text: String(e?.message || e) }, "err");
      }
    }

    function handleStreamEvent(ev) {
      if (ev.kind === "heartbeat") return;
      // Backend appendEvent destructures { kind, severity, ...payload } —
      // so over the wire we get { seq, at, kind, severity, payload: { ... } }.
      // Unwrap so the rest of this function can read flat fields the way
      // admin/mock-stream.js does it.
      const p = ev.payload || {};
      const flat = { ...ev, ...p };

      // Pause: import is waiting on a user choice (trigger picker etc).
      if (flat.kind === "needs_input") {
        // payload.input is the PendingInput; spread it so openNeedsInput
        // can read q.question / q.type / q.options directly.
        const input = p.input || {};
        openNeedsInput({ ...flat, ...input });
        return;
      }

      state.jobEvents.push(flat);
      // Best-effort classification for log coloring.
      const text = flat.text || flat.label || flat.message || (flat.kind === "exported" ? "exported: " + (flat.name || flat.id)
                  : flat.kind === "flow_imported" ? "flow imported: " + (flat.name || flat.id)
                  : flat.kind === "fail" ? "failed: " + (flat.name || flat.id) + " — " + (flat.error || "")
                  : flat.kind === "done" ? "done"
                  : flat.kind === "summary" ? JSON.stringify(flat)
                  : flat.kind);
      const cls = flat.severity === "error" || flat.kind === "fail" || flat.kind === "error" ? "err"
                : flat.severity === "warning" || flat.kind === "warn" ? "warn"
                : flat.kind === "step" ? "step"
                : flat.severity === "success" ? "success"
                : "info";
      appendLog({ text }, cls);

      if (flat.kind === "done") {
        state.jobStatus = "completed";
        $("status-dot").className = "status-dot completed";
        $("status-label").textContent = "Done";
      }
    }

    function appendLog(ev, cls) {
      const log = $("log");
      if (!log) return;
      const div = document.createElement("div");
      div.className = "line " + (cls || "info");
      div.textContent = ev.text || "";
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
    }

    function finishJob() {
      if (state.jobStatus !== "failed" && state.jobStatus !== "completed") {
        state.jobStatus = "completed";
      }
      const dot = $("status-dot");
      const label = $("status-label");
      if (dot && label) {
        dot.className = "status-dot " + (state.jobStatus === "failed" ? "failed" : "completed");
        label.textContent = state.jobStatus === "failed" ? "Failed" : "Done";
      }
    }

    // ─── Needs-input modal ─────────────────────────────────────────────
    // Mirrors admin/components/needs-input.jsx UX: header, item context,
    // prominent question, italic clarifying context, type-specific
    // input. Reads the prompt from ev.input (the event nests the
    // PendingInput object — common bug if you read fields off ev directly).
    let currentInputId = null;
    function openNeedsInput(ev) {
      const q = ev.input || ev; // backwards-compat with flat shape too
      currentInputId = q.id;
      // Item context line: "While importing <itemLabel>"
      const meta = q.itemLabel || q.itemName
        ? 'While importing <span style="font-family:Instrument Serif,serif;font-size:14px;color:#e6edf3">' + escapeHtml(q.itemLabel || q.itemName) + '</span>'
        : "";
      $("ni-meta").innerHTML = meta;
      $("ni-question").textContent = q.question || "Input needed";
      if (q.context) {
        $("ni-context").textContent = q.context;
        $("ni-context").style.display = "block";
      } else {
        $("ni-context").style.display = "none";
      }
      $("ni-err").textContent = "";

      // Determine input type. If no explicit type but options[] present,
      // assume choice (mirrors admin behavior).
      const type = q.type || ((q.options && q.options.length) ? "choice" : "text");
      const wrap = $("ni-input-wrap");
      wrap.innerHTML = "";

      if (type === "boolean") {
        // Side-by-side Yes/No buttons that immediately submit the answer.
        const trueLabel = escapeHtml(q.trueLabel || "Yes");
        const falseLabel = escapeHtml(q.falseLabel || "No");
        wrap.innerHTML =
          '<div style="display:flex;gap:8px">' +
            '<button onclick="submitBoolNeedsInput(true)" style="flex:1;padding:10px;background:#1f6feb;color:white;border:0;border-radius:4px;font-size:13px;font-weight:500;font-family:inherit;cursor:pointer">' + trueLabel + '</button>' +
            '<button onclick="submitBoolNeedsInput(false)" style="flex:1;padding:10px;background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:4px;font-size:13px;font-weight:500;font-family:inherit;cursor:pointer">' + falseLabel + '</button>' +
          '</div>';
        $("ni-apply-all-wrap").style.display = q.hideApplyAll ? "none" : "flex";
      } else if (type === "choice" && Array.isArray(q.options) && q.options.length) {
        // Vertical list of clickable buttons. Click submits immediately.
        const overflow = q.options.length > 8 ? "max-height:360px;overflow-y:auto;padding-right:4px;" : "";
        wrap.innerHTML =
          '<div style="display:flex;flex-direction:column;gap:6px;' + overflow + '">' +
            q.options.map((o, i) => {
              const v = escapeHtml(String(o.value));
              const label = escapeHtml(String(o.label));
              return '<button onclick="submitChoiceNeedsInput(' + i + ')" style="text-align:left;padding:9px 12px;background:#010409;border:1px solid #30363d;border-radius:4px;font-size:12px;color:#e6edf3;cursor:pointer;display:flex;align-items:baseline;gap:12px;font-family:inherit" onmouseover="this.style.borderColor=\\'#58a6ff\\'" onmouseout="this.style.borderColor=\\'#30363d\\'">' +
                '<span style="color:#58a6ff;font-family:SF Mono,Monaco,Consolas,monospace;font-size:11px">' + v + '</span>' +
                '<span style="color:#8b949e">' + label + '</span>' +
              '</button>';
            }).join("") +
          '</div>';
        // Cache options for submitChoiceNeedsInput
        currentInputOptions = q.options;
        $("ni-apply-all-wrap").style.display = q.hideApplyAll ? "none" : "flex";
      } else {
        // Text input — multiline textarea if the default contains \\n.
        const def = q.default || "";
        const multiline = def.indexOf("\\n") >= 0;
        const inputHtml = multiline
          ? '<textarea id="ni-text" rows="4" style="flex:1;background:#010409;border:1px solid #30363d;color:#e6edf3;padding:8px 10px;border-radius:4px;font-size:13px;font-family:SF Mono,Monaco,Consolas,monospace;resize:vertical">' + escapeHtml(def) + '</textarea>'
          : '<input type="text" id="ni-text" value="' + escapeHtml(def) + '" placeholder="' + escapeHtml(q.placeholder || "Type your answer…") + '" autocomplete="off" style="flex:1;background:#010409;border:1px solid #30363d;color:#e6edf3;padding:8px 10px;border-radius:4px;font-size:13px;font-family:inherit" />';
        wrap.innerHTML =
          '<div style="display:flex;gap:8px;align-items:flex-start">' +
            inputHtml +
            '<button onclick="submitTextNeedsInput()" style="padding:8px 14px;background:#1f6feb;color:white;border:0;border-radius:4px;font-size:13px;font-weight:500;font-family:inherit;cursor:pointer">Submit</button>' +
          '</div>';
        $("ni-apply-all-wrap").style.display = q.hideApplyAll ? "none" : "flex";
      }

      $("ni-scrim").classList.add("open");
      const first = wrap.querySelector("input,textarea,button");
      if (first) first.focus();
    }

    let currentInputOptions = [];

    async function submitNeedsInputAnswer(answer) {
      if (!currentInputId || !state.jobId) return;
      $("ni-err").textContent = "";
      try {
        const r = await fetch("/api/r/jobs/" + encodeURIComponent(state.jobId) + "/inputs", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ inputId: currentInputId, answer }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          $("ni-err").textContent = data.error || ("Failed (" + r.status + ")");
          return;
        }
        closeNeedsInput();
      } catch (e) {
        $("ni-err").textContent = String(e.message || e);
      }
    }

    function submitBoolNeedsInput(val) {
      submitNeedsInputAnswer(val ? "true" : "false");
    }
    function submitChoiceNeedsInput(idx) {
      const opt = currentInputOptions[idx];
      if (!opt) return;
      submitNeedsInputAnswer(String(opt.value));
    }
    function submitTextNeedsInput() {
      const el = $("ni-text");
      if (!el) return;
      const v = String(el.value || "").trim();
      if (!v) return;
      submitNeedsInputAnswer(v);
    }
    function skipNeedsInput() {
      // Sentinel string the pipeline interprets as "drop this item and
      // continue with the next." Same as admin's skipNeedsInput.
      submitNeedsInputAnswer("__skip__");
    }

    function closeNeedsInput() {
      $("ni-scrim").classList.remove("open");
      currentInputId = null;
      currentInputOptions = [];
    }

    // ─── Modal (Add Store) ──────────────────────────────────────────────
    function openModal() {
      $("scrim").classList.add("open");
      $("err").textContent = "";
      $("f-name").focus();
    }
    function closeModal() {
      $("scrim").classList.remove("open");
      ["f-name","f-klav","f-jwt"].forEach((id) => { $(id).value = ""; });
    }

    async function saveStore() {
      const body = {
        name: $("f-name").value,
        klaviyoKey: $("f-klav").value,
        redoJwt: $("f-jwt").value,
      };
      $("save").disabled = true;
      $("err").textContent = "";
      try {
        const r = await fetch("/api/r/stores", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          $("err").textContent = data.error || ("Failed (" + r.status + ")");
          return;
        }
        closeModal();
        await renderStoresView();
      } catch (e) {
        $("err").textContent = String(e.message || e);
      } finally {
        $("save").disabled = false;
      }
    }

    // ─── Wire up + boot ────────────────────────────────────────────────
    $("cancel").onclick = closeModal;
    $("save").onclick = saveStore;
    $("scrim").onclick = (e) => { if (e.target === $("scrim")) closeModal(); };
    $("ni-skip").onclick = skipNeedsInput;
    // Enter inside the needs-input modal submits the text input (the only
    // type that doesn't already submit-on-click). Boolean + choice both
    // submit immediately on button click.
    $("ni-scrim").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && $("ni-scrim").classList.contains("open")) {
        if ($("ni-text")) {
          e.preventDefault();
          submitTextNeedsInput();
        }
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && $("scrim").classList.contains("open")) closeModal();
      // Intentionally NOT closing the needs-input modal on Escape —
      // the import is paused waiting for an answer.
    });
    window.addEventListener("hashchange", () => { routeFromHash(); });

    window.openModal = openModal;
    window.openStore = openStore;
    window.openJob = openJob;
    window.renderStoresView = renderStoresView;
    window.runImport = runImport;
    window.switchTab = switchTab;
    window.toggleItem = toggleItem;
    window.selectAllVisible = selectAllVisible;
    window.submitBoolNeedsInput = submitBoolNeedsInput;
    window.submitChoiceNeedsInput = submitChoiceNeedsInput;
    window.submitTextNeedsInput = submitTextNeedsInput;
    window.skipNeedsInput = skipNeedsInput;

    // ─── Jobs sidebar ──────────────────────────────────────────────────
    // Always-visible right rail listing all reviewer jobs with their
    // imported items + a note textarea per item. Notes write to the
    // same jobs.notes column admin's bundle download reads from.
    const jobsState = {
      jobs: [],
      expanded: new Set(), // job ids currently expanded
      pollTimer: null,
    };

    async function loadJobs() {
      try {
        const r = await fetch("/api/r/jobs", { credentials: "same-origin" });
        if (!r.ok) return;
        const { jobs } = await r.json();
        // Sort newest first.
        jobsState.jobs = jobs.sort((a, b) =>
          (b.createdAt || "").localeCompare(a.createdAt || ""),
        );
        renderJobsPanel();
      } catch (_) { /* swallow */ }
    }

    function renderJobsPanel() {
      const jobs = jobsState.jobs;
      $("jobs-total").textContent = jobs.length + " total";
      if (jobs.length === 0) {
        $("jobs-list").innerHTML = '<div class="jobs-empty">No jobs yet.<br>Pick items from a store and hit Import.</div>';
        return;
      }
      $("jobs-list").innerHTML = jobs.map(renderJobCard).join("");
    }

    function renderJobCard(j) {
      const isExpanded = jobsState.expanded.has(j.id);
      const dot = j.status === "running" ? "running"
                : j.status === "awaiting_input" ? "awaiting_input"
                : j.status === "completed" ? "completed"
                : j.status === "partial" ? "partial"
                : j.status === "failed" ? "failed"
                : "completed";
      const when = relativeTime(j.createdAt);
      const itemCount = (j.items || []).length;
      const noteCount = (j.items || []).filter((it) => it.note).length;
      return (
        '<div class="job-card" onclick="toggleJobExpand(\\'' + j.id + '\\')">' +
          '<div class="row1">' +
            '<span class="dot ' + dot + '"></span>' +
            '<span class="store-name">' + escapeHtml(j.storeName || "—") + '</span>' +
            '<span class="when">' + when + '</span>' +
          '</div>' +
          '<div class="stats">' +
            escapeHtml(j.status) + ' · ' + itemCount + ' item' + (itemCount === 1 ? '' : 's') +
            (noteCount > 0 ? ' · <span style="color:#3fb950">' + noteCount + ' noted</span>' : '') +
          '</div>' +
        '</div>' +
        (isExpanded ? renderJobItems(j) : '')
      );
    }

    function renderJobItems(j) {
      const items = j.items || [];
      if (items.length === 0) {
        return '<div class="job-items"><div style="font-size:11px;color:#6e7681;padding:4px 0">No items imported yet.</div></div>';
      }
      return '<div class="job-items">' + items.map((it) => {
        const stateLabel = escapeHtml(it.state);
        const author = it.noteAuthor ? '<span style="color:#6e7681">by ' + escapeHtml(it.noteAuthor) + '</span>' : '';
        return (
          '<div class="job-item">' +
            '<div class="head">' +
              '<span class="kind ' + escapeHtml(it.type) + '">' + escapeHtml(it.type) + '</span>' +
              '<span class="name">' + escapeHtml(it.name) + '</span>' +
              '<span class="state ' + escapeHtml(it.state) + '">' + stateLabel + '</span>' +
            '</div>' +
            '<textarea placeholder="Notes (visible to admin)…" data-job="' + escapeHtml(j.id) + '" data-item="' + escapeHtml(it.id) + '">' + escapeHtml(it.note || "") + '</textarea>' +
            '<div class="note-status" id="note-status-' + escapeHtml(j.id + '-' + it.id) + '">' + author + '</div>' +
          '</div>'
        );
      }).join("") + '</div>';
    }

    function relativeTime(iso) {
      if (!iso) return "";
      const ms = Date.now() - new Date(iso).getTime();
      if (ms < 60_000) return "just now";
      const m = Math.floor(ms / 60_000);
      if (m < 60) return m + "m";
      const h = Math.floor(m / 60);
      if (h < 24) return h + "h";
      const d = Math.floor(h / 24);
      return d + "d";
    }

    function toggleJobExpand(jobId) {
      if (jobsState.expanded.has(jobId)) jobsState.expanded.delete(jobId);
      else jobsState.expanded.add(jobId);
      renderJobsPanel();
    }

    // Debounced note save — write to /api/r/jobs/:id/notes after 600ms
    // of idle. Status indicator shows saving/saved transitions.
    const noteSaveTimers = new Map();
    function onJobNoteInput(textarea) {
      const jobId = textarea.dataset.job;
      const itemId = textarea.dataset.item;
      const note = textarea.value;
      const key = jobId + ":" + itemId;
      const statusEl = $("note-status-" + jobId + "-" + itemId);
      if (statusEl) statusEl.innerHTML = '<span class="saving">saving…</span>';

      clearTimeout(noteSaveTimers.get(key));
      noteSaveTimers.set(key, setTimeout(async () => {
        try {
          const r = await fetch(
            "/api/r/jobs/" + encodeURIComponent(jobId) + "/notes",
            {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ itemId, note }),
            },
          );
          if (r.ok) {
            if (statusEl) statusEl.innerHTML = '<span class="saved">✓ saved</span>';
            // Refresh cached jobs so the count badge updates.
            const job = jobsState.jobs.find((j) => j.id === jobId);
            if (job) {
              const it = (job.items || []).find((x) => x.id === itemId);
              if (it) it.note = note || null;
            }
          } else {
            if (statusEl) statusEl.innerHTML = '<span style="color:#f78166">save failed</span>';
          }
        } catch (e) {
          if (statusEl) statusEl.innerHTML = '<span style="color:#f78166">save failed</span>';
        }
      }, 600));
    }

    // Delegate textarea input → save (one listener covers all current and
    // future job-item textareas).
    $("jobs-list").addEventListener("input", (e) => {
      if (e.target?.tagName === "TEXTAREA" && e.target.dataset?.job) {
        onJobNoteInput(e.target);
      }
    });

    // Poll jobs list every 8s so new imports + status transitions show up
    // without a manual refresh. Cheap query — reviewer typically has few jobs.
    function startJobsPolling() {
      if (jobsState.pollTimer) clearInterval(jobsState.pollTimer);
      jobsState.pollTimer = setInterval(loadJobs, 8000);
    }

    window.toggleJobExpand = toggleJobExpand;

    loadMe().then((me) => {
      if (me) {
        routeFromHash();
        loadJobs();
        startJobsPolling();
      }
    });
  </script>
</body>
</html>`;

// GET /dashboard — Phase 2 reviewer dashboard. Stores list + Add Store modal.
function handleReviewerDashboard(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(REVIEWER_DASHBOARD_HTML);
}

// Surface dispatch. Returns true if the request was handled (response
// already sent); false if it should fall through to the admin routes.
// On the public_review surface, returns true for ANY request — admin
// endpoints get a 404 instead of falling through. On admin surface,
// returns false so existing routing runs unchanged.
async function dispatchReviewerSurface(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (MIME_SURFACE !== "public_review") return false;

  const rawUrl = req.url ?? "";
  const path = rawUrl.split("?")[0];

  // GET /r/<token>/ — handshake. Token is the URL segment after /r/.
  const handshake = path.match(/^\/r\/([^/]+)\/?$/);
  if (req.method === "GET" && handshake) {
    await handleReviewerHandshake(req, res, decodeURIComponent(handshake[1]));
    return true;
  }
  if (req.method === "GET" && (path === "/dashboard" || path === "/dashboard/")) {
    handleReviewerDashboard(res);
    return true;
  }
  if (req.method === "GET" && path === "/api/r/me") {
    await handleReviewerMe(req, res);
    return true;
  }
  // ─── Reviewer-scoped store CRUD ──────────────────────────────────────
  if (req.method === "GET" && (path === "/api/r/stores" || rawUrl.startsWith("/api/r/stores?"))) {
    await handleReviewerStoresList(req, res);
    return true;
  }
  if (req.method === "POST" && path === "/api/r/stores") {
    await handleReviewerStoreCreate(req, res);
    return true;
  }
  const storePath = path.match(/^\/api\/r\/stores\/([^/?]+)$/);
  if (storePath) {
    const sid = decodeURIComponent(storePath[1]);
    if (req.method === "GET") {
      await handleReviewerStoreGet(req, res, sid);
      return true;
    }
    if (req.method === "PATCH") {
      await handleReviewerStoreUpdate(req, res, sid);
      return true;
    }
    if (req.method === "DELETE") {
      await handleReviewerStoreDelete(req, res, sid);
      return true;
    }
  }
  // ─── Phase 3: per-store flows/templates/campaigns list + import ─────
  const storeFlowsPath = path.match(/^\/api\/r\/stores\/([^/?]+)\/flows$/);
  if (storeFlowsPath && req.method === "POST") {
    await handleReviewerStoreFlowsList(req, res, decodeURIComponent(storeFlowsPath[1]));
    return true;
  }
  const storeTemplatesPath = path.match(/^\/api\/r\/stores\/([^/?]+)\/templates$/);
  if (storeTemplatesPath && req.method === "POST") {
    await handleReviewerStoreTemplatesList(req, res, decodeURIComponent(storeTemplatesPath[1]));
    return true;
  }
  const storeCampaignsPath = path.match(/^\/api\/r\/stores\/([^/?]+)\/campaigns$/);
  if (storeCampaignsPath && req.method === "POST") {
    await handleReviewerStoreCampaignsList(req, res, decodeURIComponent(storeCampaignsPath[1]));
    return true;
  }
  const storeImportPath = path.match(/^\/api\/r\/stores\/([^/?]+)\/import$/);
  if (storeImportPath && req.method === "POST") {
    await handleReviewerImport(req, res, decodeURIComponent(storeImportPath[1]));
    return true;
  }
  // ─── Phase 3: jobs list + detail + NDJSON stream ────────────────────
  if (req.method === "GET" && (path === "/api/r/jobs" || rawUrl.startsWith("/api/r/jobs?"))) {
    await handleReviewerJobsList(req, res);
    return true;
  }
  const jobPath = path.match(/^\/api\/r\/jobs\/([^/?]+)(\/stream|\/inputs|\/notes)?$/);
  if (jobPath) {
    const jid = decodeURIComponent(jobPath[1]);
    const sub = jobPath[2];
    if (req.method === "GET" && !sub) {
      await handleReviewerJobGet(req, res, jid);
      return true;
    }
    if (req.method === "GET" && sub === "/stream") {
      await handleReviewerJobStream(req, res, jid);
      return true;
    }
    if (req.method === "POST" && sub === "/inputs") {
      await handleReviewerJobInput(req, res, jid);
      return true;
    }
    if (req.method === "POST" && sub === "/notes") {
      await handleReviewerJobNotes(req, res, jid);
      return true;
    }
  }
  if (req.method === "GET" && path === "/") {
    // Public surface is open access — landing redirects straight to the
    // dashboard. No personalized link needed.
    res.writeHead(302, { location: "/dashboard" });
    res.end();
    return true;
  }

  // Anything else on the public surface 404s — admin/assist/import
  // routes physically don't get evaluated here.
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
  return true;
}

// ─── HTML ──────────────────────────────────────────────────────────────────

const HTML = /* html */ `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Klaviyo → Redo Migration</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font: 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0d1117; color: #e6edf3;
      min-height: 100vh; padding: 24px;
    }
    .wrap { max-width: 1100px; margin: 0 auto; }
    h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
    .subtitle { color: #8b949e; font-size: 12px; margin-bottom: 24px; }

    .card {
      background: #161b22; border: 1px solid #30363d; border-radius: 8px;
      padding: 20px; margin-bottom: 16px;
    }
    .card h2 {
      font-size: 13px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.5px; color: #8b949e; margin-bottom: 16px;
    }

    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .grid2 .span2 { grid-column: 1 / -1; }
    label { display: block; font-size: 12px; color: #8b949e; margin-bottom: 4px; }
    input[type=text], input[type=password] {
      width: 100%; padding: 8px 10px;
      background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
      color: #e6edf3; font: 13px 'SF Mono', Menlo, monospace;
    }
    input:focus { outline: none; border-color: #388bfd; }

    button {
      padding: 8px 16px; border: 1px solid #30363d; background: #21262d;
      color: #e6edf3; font-size: 13px; border-radius: 6px; cursor: pointer;
    }
    button:hover:not(:disabled) { background: #30363d; }
    button.primary {
      background: #238636; border-color: #2ea043; color: #fff;
    }
    button.primary:hover:not(:disabled) { background: #2ea043; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }

    .toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
    .counter { color: #8b949e; font-size: 12px; align-self: center; }

    .template-list {
      max-height: 420px; overflow-y: auto;
      background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
    }
    .template-row {
      display: grid; grid-template-columns: 24px 1fr auto auto auto;
      gap: 12px; padding: 8px 12px; border-bottom: 1px solid #21262d;
      font-size: 13px; align-items: center;
    }
    .template-row:last-child { border-bottom: none; }
    .template-row:hover { background: #161b22; }
    .template-row.selected { background: #1a2a3a; }
    .template-row input[type=checkbox] { cursor: pointer; }
    .template-row .name { color: #e6edf3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .template-row .id { font-family: 'SF Mono', monospace; color: #6e7681; font-size: 11px; }
    .template-row .date { color: #8b949e; font-size: 11px; }
    .template-row .tag {
      padding: 2px 6px; border-radius: 10px; font-size: 10px;
      background: #30363d; color: #8b949e; font-weight: 600;
    }
    .template-row .tag.code { background: #3a1a2a; color: #da3633; }

    .flow-group { border-bottom: 1px solid #30363d; }
    .flow-group:last-child { border-bottom: none; }
    .flow-header {
      display: grid; grid-template-columns: 24px 1fr auto auto auto;
      gap: 12px; padding: 10px 12px; background: #161b22;
      font-size: 13px; align-items: center; cursor: pointer;
      user-select: none;
    }
    .flow-header:hover { background: #1a2030; }
    .flow-header .chevron { color: #8b949e; width: 14px; display: inline-block; transition: transform 0.15s; }
    .flow-header.collapsed .chevron { transform: rotate(-90deg); }
    .flow-header .flow-name { color: #e6edf3; font-weight: 600; }
    .flow-header .status-pill {
      padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600;
    }
    .flow-header .status-pill.live { background: #1a3a2a; color: #3fb950; }
    .flow-header .status-pill.draft { background: #30363d; color: #8b949e; }
    .flow-header .status-pill.manual { background: #2a2a3a; color: #8b949e; }
    .flow-header .count { color: #8b949e; font-size: 11px; }
    .flow-emails { padding-left: 20px; }
    .flow-emails.collapsed { display: none; }
    .flow-emails .template-row { background: transparent; }

    .log {
      background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
      padding: 12px; max-height: 400px; overflow-y: auto;
      font: 12px 'SF Mono', Menlo, monospace; color: #e6edf3;
      white-space: pre-wrap; line-height: 1.5;
    }
    .log .line { margin-bottom: 2px; }
    .log .step { color: #58a6ff; font-weight: 600; }
    .log .info { color: #8b949e; }
    .log .warn { color: #d29922; }
    .log .exported { color: #3fb950; }
    .log .fail { color: #f85149; }
    .log .done { color: #3fb950; font-weight: 600; }
    .log .error { color: #f85149; font-weight: 600; }
    .log .stdout { color: #e6edf3; }
    .log .stderr { color: #d29922; }
    .log .summary { color: #58a6ff; font-weight: 600; }

    .search {
      width: 100%; margin-bottom: 8px; padding: 6px 10px;
      background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
      color: #e6edf3; font-size: 13px;
    }

    .pill {
      display: inline-block; padding: 1px 8px; border-radius: 10px;
      font-size: 11px; font-weight: 600;
    }
    .pill.ok { background: #1a3a2a; color: #3fb950; }
    .pill.warn { background: #3a2a1a; color: #d29922; }
    .pill.fail { background: #3a1a1a; color: #f85149; }

    details { margin-top: 8px; }
    details summary { cursor: pointer; color: #8b949e; font-size: 12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Klaviyo → Redo Migration</h1>
    <div class="subtitle">mime preview UI · localhost:${PORT}</div>

    <div class="card">
      <h2>1. Credentials</h2>
      <div class="grid2">
        <div>
          <label>Klaviyo API key</label>
          <input type="password" id="klaviyoKey" placeholder="pk_..." autocomplete="off" />
        </div>
        <div>
          <label>Redo store ID (team _id)</label>
          <input type="text" id="storeId" placeholder="69dff28302f64f42e6012a4d" />
        </div>
        <div>
          <label>Merchant slug (directory name under migrations/)</label>
          <input type="text" id="merchantSlug" placeholder="acme-brand" />
        </div>
        <div>
          <label>Anthropic key (optional — for coupon rewrites)</label>
          <input type="password" id="anthropicKey" placeholder="sk-ant-... (leave blank to skip AI)" autocomplete="off" />
        </div>
        <div class="span2">
          <label>
            Redo auth token (merchant JWT — required for RPC import)
            <span style="color:#8b949e;font-weight:normal;">·
              <a href="#" id="jwtHelpLink" style="color:#58a6ff;">how to find this</a>
            </span>
          </label>
          <input type="password" id="redoJwt" placeholder="eyJhbGc... (leave blank to export only)" autocomplete="off" />
          <div id="jwtHelp" style="display:none; margin-top:6px; padding:8px; background:#161b22; border-radius:4px; color:#8b949e; font-size:12px; line-height:1.5;">
            In Chrome, open the Redo admin at <code>app.getredo.com</code> while logged in.
            Open DevTools → Application → Local Storage → <code>https://app.getredo.com</code>.
            Copy the value of the key <code>redo.merchant_auth_token.&lt;storeId&gt;</code>
            (where storeId matches the team you're importing into). Paste it here.
          </div>
        </div>
      </div>
      <div style="margin-top: 12px; display: flex; gap: 8px; align-items: center;">
        <button id="loadTemplatesBtn" class="primary">Load templates</button>
        <button id="loadFlowsBtn">Load flows</button>
        <span class="counter" id="accountInfo"></span>
      </div>
    </div>

    <div class="card" id="templatesCard" style="display: none;">
      <h2 id="listHeader">2. Select templates</h2>
      <input type="text" class="search" id="search" placeholder="Filter by name…" />
      <div class="toolbar">
        <button id="selectAll">Select all</button>
        <button id="selectNone">Select none</button>
        <button id="invertSel">Invert</button>
        <span class="counter"><span id="selectedCount">0</span> / <span id="totalCount">0</span> selected</span>
      </div>
      <div class="template-list" id="templateList"></div>
    </div>

    <div class="card" id="runCard" style="display: none;">
      <h2>3. Run migration</h2>
      <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 12px;">
        <button id="runBtn" class="primary">Export + Import</button>
        <label id="runImportLabel" style="display: flex; align-items: center; gap: 6px; color: #e6edf3;">
          <input type="checkbox" id="runImport" checked />
          <span id="runImportText">Also run import (uncheck to export only)</span>
        </label>
      </div>
      <div class="log" id="log"></div>
    </div>
  </div>

  <script>
    const el = (id) => document.getElementById(id);
    let mode = 'templates'; // 'templates' | 'flows'
    let templates = [];     // used in 'templates' mode
    let flows = [];         // used in 'flows' mode
    let selected = new Set(); // template IDs

    // Local storage for convenience
    const SAVED_KEYS = ['klaviyoKey', 'storeId', 'merchantSlug', 'anthropicKey', 'redoJwt'];
    for (const k of SAVED_KEYS) {
      const saved = localStorage.getItem('mime.' + k);
      if (saved) el(k).value = saved;
    }
    for (const k of SAVED_KEYS) {
      el(k).addEventListener('change', () => localStorage.setItem('mime.' + k, el(k).value));
    }

    // JWT help toggle
    el('jwtHelpLink').addEventListener('click', (e) => {
      e.preventDefault();
      const h = el('jwtHelp');
      h.style.display = h.style.display === 'none' ? 'block' : 'none';
    });

    // ── Env detection — surface what's available server-side.
    //   hostedDeploy: relabels the import checkbox so it's clear import needs a JWT.
    //   aiAvailable : server already has an Anthropic key (Replit AI Integrations or
    //                 ANTHROPIC_API_KEY). When true we hide the manual key field and
    //                 keep skipAi=false so the user doesn't have to paste anything.
    let _envAiAvailable = false;
    fetch('/api/env').then(r => r.json()).then(env => {
      if (env.hostedDeploy) {
        const t = el('runImportText');
        if (t) t.textContent = 'Also import (requires auth token; uncheck to export only)';
      }
      if (env.aiAvailable) {
        _envAiAvailable = true;
        const f = el('anthropicKey');
        if (f) {
          const wrapper = f.closest('div');
          if (wrapper) wrapper.style.display = 'none';
        }
      }
    }).catch(() => {});

    // ── Load (templates or flows) ───────────────────────────────────
    async function load(which) {
      const key = el('klaviyoKey').value.trim();
      if (!key) return alert('Klaviyo API key required');
      const btn = which === 'templates' ? el('loadTemplatesBtn') : el('loadFlowsBtn');
      const otherBtn = which === 'templates' ? el('loadFlowsBtn') : el('loadTemplatesBtn');
      btn.disabled = true; otherBtn.disabled = true;
      btn.textContent = 'Loading…';
      el('accountInfo').textContent = '';
      try {
        const path = which === 'templates' ? '/api/templates' : '/api/flows';
        const r = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ klaviyoKey: key }),
        });
        if (!r.ok) {
          const err = await r.json();
          throw new Error(err.error || r.statusText);
        }
        const body = await r.json();
        mode = which;
        selected = new Set();
        if (which === 'templates') {
          templates = body.templates;
          el('accountInfo').textContent = \`\${body.accountName || ''} · \${templates.length} templates\`;
          el('totalCount').textContent = templates.length;
          el('listHeader').textContent = '2. Select templates';
          renderTemplatesList();
        } else {
          flows = body.flows;
          const emailCount = flows.reduce((acc, f) => acc + f.emails.filter(e => e.templateId).length, 0);
          el('accountInfo').textContent = \`\${flows.length} flows · \${emailCount} flow emails\`;
          el('totalCount').textContent = emailCount;
          el('listHeader').textContent = '2. Select flow emails';
          // Stash debug info for inspection via console; also log it.
          window._mimeDebug = body.debug;
          if (body.debug) console.log('[flows debug]', body.debug);
          renderFlowsList();
          // If we got nothing, surface the diagnostic summary inline.
          if (flows.length === 0 && body.debug) {
            const d = body.debug;
            const topTypes = Object.entries(d.actionTypeCounts)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([t, n]) => t + ' (' + n + ')')
              .join(', ');
            el('templateList').innerHTML =
              '<div style="padding:16px;color:#8b949e;font-family:SF Mono,monospace;font-size:12px;line-height:1.8">' +
              'No flow emails found.<br><br>' +
              'Walked <b>' + d.totalFlows + '</b> flows.<br>' +
              '<b>' + d.flowsWithActions + '</b> had actions, <b>' + d.flowsWithNoActions + '</b> had none.<br>' +
              '<b>' + d.messagesSeen + '</b> messages across all actions.<br>' +
              '<b>' + d.messagesWithTemplate + '</b> with template, <b>' + d.messagesWithoutTemplate + '</b> without.<br>' +
              'Failed action fetches: <b>' + d.failedActionFetches + '</b>, failed message fetches: <b>' + d.failedMessageFetches + '</b>.<br>' +
              'Action types seen: ' + (topTypes || '(none)') + '<br>' +
              'Sample flows: ' + (d.sampleFlowNames.slice(0, 5).join(', ') || '(none)') + '<br>' +
              ((d.sampleMessageFetchErrors || []).length > 0
                ? '<br><b>Errors:</b><br>' +
                  d.sampleMessageFetchErrors.map(e => '&nbsp;&nbsp;' + escapeHtml(e)).join('<br>')
                : '') +
              '</div>';
          }
        }
        el('templatesCard').style.display = 'block';
        el('runCard').style.display = 'block';
      } catch (e) {
        alert('Failed: ' + e.message);
      } finally {
        el('loadTemplatesBtn').disabled = false;
        el('loadFlowsBtn').disabled = false;
        el('loadTemplatesBtn').textContent = 'Load templates';
        el('loadFlowsBtn').textContent = 'Load flows';
      }
    }
    el('loadTemplatesBtn').addEventListener('click', () => load('templates'));
    el('loadFlowsBtn').addEventListener('click', () => load('flows'));

    function renderTemplatesList() {
      const filter = el('search').value.trim().toLowerCase();
      const list = el('templateList');
      list.innerHTML = '';
      const matches = templates.filter(t => !filter || t.name.toLowerCase().includes(filter));
      for (const t of matches) {
        list.appendChild(buildTemplateRow(t.id, t.name, t.editorType, (t.updated || '').slice(0, 10)));
      }
      updateCounter();
    }

    function renderFlowsList() {
      const filter = el('search').value.trim().toLowerCase();
      const list = el('templateList');
      list.innerHTML = '';
      for (const flow of flows) {
        // Filter: match on flow name or any email name. Keep emails with
        // no templateId in the list (rendered disabled) so the user can
        // see what exists in the flow — better than silently dropping.
        const matchEmails = flow.emails.filter(e => {
          if (!filter) return true;
          return flow.flowName.toLowerCase().includes(filter) ||
                 (e.name || '').toLowerCase().includes(filter);
        });
        if (matchEmails.length === 0) continue;

        const group = document.createElement('div');
        group.className = 'flow-group';

        const header = document.createElement('div');
        header.className = 'flow-header';
        const selectableEmails = matchEmails.filter(e => !!e.templateId);
        const allSelected = selectableEmails.length > 0 &&
          selectableEmails.every(e => selected.has(e.templateId));
        header.innerHTML = \`
          <input type="checkbox" \${allSelected ? 'checked' : ''} />
          <div><span class="chevron">▼</span> <span class="flow-name">\${escapeHtml(flow.flowName)}</span></div>
          <span class="status-pill \${flow.flowStatus}">\${flow.flowStatus}</span>
          <span class="count">\${matchEmails.length} email\${matchEmails.length === 1 ? '' : 's'}</span>
          <span class="id">\${flow.triggerType || ''}</span>
        \`;
        const emailsContainer = document.createElement('div');
        emailsContainer.className = 'flow-emails';
        for (const e of matchEmails) {
          const emailName = e.name || \`Email (msg \${e.messageId})\`;
          if (e.templateId) {
            emailsContainer.appendChild(buildTemplateRow(e.templateId, emailName, 'draggable', ''));
          } else {
            emailsContainer.appendChild(buildDisabledRow(emailName, e.messageId));
          }
        }
        group.appendChild(header);
        group.appendChild(emailsContainer);

        const groupCb = header.querySelector('input');
        groupCb.addEventListener('change', (ev) => {
          ev.stopPropagation();
          const check = groupCb.checked;
          for (const e of matchEmails) {
            if (!e.templateId) continue; // skip no-template rows
            if (check) selected.add(e.templateId);
            else selected.delete(e.templateId);
          }
          renderFlowsList();
        });
        header.addEventListener('click', (ev) => {
          if (ev.target === groupCb) return;
          emailsContainer.classList.toggle('collapsed');
          header.classList.toggle('collapsed');
        });
        list.appendChild(group);
      }
      updateCounter();
    }

    function buildTemplateRow(templateId, name, editorType, date) {
      const row = document.createElement('div');
      row.className = 'template-row' + (selected.has(templateId) ? ' selected' : '');
      const tagCls = editorType === 'CODE' ? 'tag code' : 'tag';
      const tagText = editorType === 'CODE' ? 'code' : 'draggable';
      row.innerHTML = \`
        <input type="checkbox" \${selected.has(templateId) ? 'checked' : ''} />
        <div class="name">\${escapeHtml(name)}</div>
        <span class="\${tagCls}">\${tagText}</span>
        <span class="date">\${date}</span>
        <span class="id">\${templateId}</span>
      \`;
      const cb = row.querySelector('input');
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(templateId);
        else selected.delete(templateId);
        row.classList.toggle('selected', cb.checked);
        updateCounter();
      });
      row.addEventListener('click', (e) => {
        if (e.target !== cb && !e.target.classList.contains('flow-name')) {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event('change'));
        }
      });
      return row;
    }

    // Rendered when a flow email has no attached template ID (Klaviyo
    // flow message with no template, draft, or SMS-rendered-as-email).
    // Visible but not selectable.
    function buildDisabledRow(name, messageId) {
      const row = document.createElement('div');
      row.className = 'template-row';
      row.style.opacity = '0.5';
      row.style.cursor = 'not-allowed';
      row.innerHTML = \`
        <input type="checkbox" disabled />
        <div class="name">\${escapeHtml(name)}</div>
        <span class="tag" style="background:#3a2a1a;color:#d29922">no template</span>
        <span class="date"></span>
        <span class="id">msg \${messageId}</span>
      \`;
      row.title = 'No template attached to this flow message — check in Klaviyo';
      return row;
    }

    function renderList() {
      if (mode === 'templates') renderTemplatesList();
      else renderFlowsList();
    }

    function updateCounter() {
      el('selectedCount').textContent = selected.size;
    }

    el('search').addEventListener('input', renderList);

    function currentVisibleTemplateIds() {
      const filter = el('search').value.trim().toLowerCase();
      const out = [];
      if (mode === 'templates') {
        for (const t of templates) {
          if (!filter || t.name.toLowerCase().includes(filter)) out.push(t.id);
        }
      } else {
        for (const f of flows) {
          const fmatch = !filter || f.flowName.toLowerCase().includes(filter);
          for (const e of f.emails) {
            if (!e.templateId) continue;
            if (fmatch || (filter && (e.name || '').toLowerCase().includes(filter))) {
              out.push(e.templateId);
            }
          }
        }
      }
      return out;
    }

    el('selectAll').addEventListener('click', () => {
      for (const id of currentVisibleTemplateIds()) selected.add(id);
      renderList();
    });
    el('selectNone').addEventListener('click', () => {
      selected.clear();
      renderList();
    });
    el('invertSel').addEventListener('click', () => {
      for (const id of currentVisibleTemplateIds()) {
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
      }
      renderList();
    });

    // ── Run ─────────────────────────────────────────────────────────
    el('runBtn').addEventListener('click', async () => {
      if (selected.size === 0) return alert('Select at least one template');
      const payload = {
        klaviyoKey: el('klaviyoKey').value.trim(),
        storeId: el('storeId').value.trim(),
        merchantSlug: el('merchantSlug').value.trim(),
        anthropicKey: el('anthropicKey').value.trim() || undefined,
        redoJwt: el('redoJwt').value.trim() || undefined,
        skipAi: !_envAiAvailable && !el('anthropicKey').value.trim(),
        runImport: el('runImport').checked,
        templateIds: [...selected],
      };
      if (!payload.storeId || !payload.merchantSlug) {
        return alert('Store ID and merchant slug are required');
      }

      el('runBtn').disabled = true;
      el('runBtn').textContent = 'Running…';
      el('log').innerHTML = '';

      try {
        const r = await fetch('/api/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.error || r.statusText);
        }
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\\n');
          buffer = parts.pop() || '';
          for (const line of parts) {
            if (!line) continue;
            try { renderEvent(JSON.parse(line)); } catch (e) { renderEvent({ kind: 'info', text: line }); }
          }
        }
      } catch (e) {
        renderEvent({ kind: 'error', text: e.message });
      } finally {
        el('runBtn').disabled = false;
        el('runBtn').textContent = 'Export + Import';
      }
    });

    function renderEvent(ev) {
      const log = el('log');
      const div = document.createElement('div');
      div.className = 'line ' + ev.kind + (ev.source ? ' ' + ev.source : '');
      let text = '';
      switch (ev.kind) {
        case 'step': text = '▶ ' + ev.label; break;
        case 'info': text = ev.text; break;
        case 'warn': text = '⚠ ' + ev.text; break;
        case 'exported': {
          const flags = [];
          if (ev.warnings) flags.push(ev.warnings + 'w');
          if (ev.unsupported) flags.push(ev.unsupported + 'u');
          if (ev.reviewItems) flags.push(ev.reviewItems + 'r');
          if (ev.aiRewrites) flags.push(ev.aiRewrites + 'ai');
          const fonts = (ev.fontPlanEntries || []).map(f =>
            f.family + (f.available ? '' : ' ✗')
          ).join(', ');
          text = '✓ ' + ev.name + ' (' + ev.sectionCount + ' sections' +
            (flags.length ? ', ' + flags.join(' ') : '') +
            (fonts ? ', fonts: ' + fonts : '') + ')';
          break;
        }
        case 'fail': text = '✗ ' + ev.name + ': ' + ev.error; break;
        case 'summary':
          text = '— ' + ev.exported + ' exported, ' + ev.failed + ' failed';
          break;
        case 'log': text = ev.text; break;
        case 'done':
          if (ev.importSkipped) text = '■ Done. Import skipped. To run manually:\\n  ' + ev.importCommand;
          else if (ev.importExitCode === 0) text = '■ Done. Import succeeded.';
          else text = '■ Done. Import exited with code ' + ev.importExitCode + '.';
          break;
        case 'error': text = '✗ ERROR: ' + ev.text; break;
        default: text = JSON.stringify(ev);
      }
      div.textContent = text;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
    }

    function escapeHtml(s) {
      return s.replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }
  </script>
</body>
</html>`;

// ─── Static-file serving for the Toby 2.0 UI ──────────────────────────────

const UI_ROOT = join(MIME_ROOT, "src/migrate/ui");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".jsx": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
};

/**
 * Attempt to serve `urlPath` from UI_ROOT. Returns true if handled
 * (including 404 on missing-but-safe paths); false when the path is
 * unsafe (tried to escape the UI dir) so the caller can 404 normally.
 */
function tryServeStatic(
  urlPath: string,
  res: ServerResponse,
): boolean {
  // Strip query string; decode URL-encoded bytes (e.g. %20 for spaces).
  const bare = decodeURIComponent(urlPath.split("?")[0]);

  // Path-traversal guard: resolve the requested file against UI_ROOT and
  // make sure it stays inside UI_ROOT.
  const rel = bare.replace(/^\/+/, "");
  const fullPath = normalize(join(UI_ROOT, rel));
  if (!fullPath.startsWith(UI_ROOT)) return false;

  if (!existsSync(fullPath)) return false;
  const stat = statSync(fullPath);
  if (!stat.isFile()) return false;

  const ext = (fullPath.match(/\.[^./]+$/)?.[0] ?? "").toLowerCase();
  const type = CONTENT_TYPES[ext] ?? "application/octet-stream";
  const body = readFileSync(fullPath);
  res.writeHead(200, {
    "content-type": type,
    "cache-control": "no-cache",
  });
  res.end(body);
  return true;
}

// ─── server ────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  try {
    // Public-review surface short-circuits here — admin/assist/import
    // routes physically don't get evaluated on that deploy. Runs BEFORE
    // checkBasicAuth so the reviewer URL token can't be accidentally
    // gated by admin-side basic-auth env vars. See
    // plans/2026-05-26-reviewer-dashboard.md.
    if (await dispatchReviewerSurface(req, res)) return;
    if (!checkBasicAuth(req, res)) return;
    // Strip query string for path-only matches below; handlers that care
    // about the query (like `/api/jobs?storeId=`) re-parse from req.url.
    const rawUrl = req.url ?? "";
    const path = rawUrl.split("?")[0];

    // GET / → assist UI entry point (external view).
    if (req.method === "GET" && (path === "/" || path === "/assist.html")) {
      if (tryServeStatic("/assist.html", res)) return;
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("assist UI not built");
      return;
    }
    // GET /<ADMIN_URL_TOKEN>/[index.html] → admin UI entry. Sets the admin
    // cookie, then serves the Toby 2.0 shell. Subsequent admin API calls
    // are gated by the cookie.
    if (req.method === "GET" && isAdminEntryUrl(req.url ?? "")) {
      setAdminCookie(res);
      if (tryServeStatic("/index.html", res)) return;
      // Fall back to the legacy inline HTML if the UI isn't present.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(HTML);
      return;
    }
    // GET /legacy → the original inline HTML (for debugging). Admin-gated.
    if (req.method === "GET" && req.url === "/legacy") {
      if (!(await requireFullAdmin(req, res))) return;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(HTML);
      return;
    }
    if (req.method === "GET" && req.url === "/api/env") {
      return json(res, 200, {
        hostedDeploy: IS_HOSTED_DEPLOY,
        aiAvailable: AI_AVAILABLE,
        // Tells the UI whether to read/write stores via /api/stores or
        // fall back to localStorage (local dev without DATABASE_URL).
        dbEnabled: isDbEnabled(),
        adminAuthEnabled: isAdminAuthEnabled(),
        isAdmin: isAdmin(req),
      });
    }
    // "Am I admin?" — used by the assist UI to decide whether to render
    // the "← Admin" back-link in its header. Open endpoint (no gate);
    // returns only the verified identity, no other secrets.
    if (req.method === "GET" && req.url === "/api/me") {
      return handleMe(req, res);
    }
    // ─── Admin-only endpoints (Klaviyo/Redo creds, import triggers, jobs) ──
    if (req.method === "POST" && req.url === "/api/templates") {
      if (!(await requireFullAdmin(req, res))) return;
      return handleTemplates(req, res);
    }
    if (req.method === "POST" && req.url === "/api/flows") {
      if (!(await requireFullAdmin(req, res))) return;
      return handleFlows(req, res);
    }
    if (req.method === "POST" && req.url === "/api/flows/stream") {
      if (!(await requireFullAdmin(req, res))) return;
      return handleFlowsStream(req, res);
    }
    if (req.method === "POST" && req.url === "/api/flows/list") {
      if (!(await requireFullAdmin(req, res))) return;
      return handleFlowsList(req, res);
    }
    if (req.method === "POST" && req.url === "/api/flows/walk-batch") {
      if (!(await requireFullAdmin(req, res))) return;
      return handleFlowsWalkBatch(req, res);
    }
    if (req.method === "POST" && req.url === "/api/campaigns") {
      if (!(await requireFullAdmin(req, res))) return;
      return handleCampaigns(req, res);
    }
    if (req.method === "POST" && req.url === "/api/run") {
      if (!(await requireFullAdmin(req, res))) return;
      return handleRun(req, res);
    }
    // Job-based dashboard endpoints — admin only.
    const url = req.url ?? "";
    // Stores CRUD — server-side merchant credentials. Match before the
    // job routes so /api/stores/:id/... never collides. Admin only —
    // these endpoints expose merchant Klaviyo keys + Redo JWTs.
    if (req.method === "GET" && (url === "/api/stores" || url.startsWith("/api/stores?"))) {
      if (!(await requireFullAdmin(req, res))) return;
      return handleStoresList(req, res);
    }
    if (req.method === "POST" && url === "/api/stores") {
      if (!(await requireFullAdmin(req, res))) return;
      return handleStoreCreate(req, res);
    }
    const storePath = url.match(/^\/api\/stores\/([^/?]+)(\?.*)?$/);
    if (storePath) {
      if (!(await requireFullAdmin(req, res))) return;
      const sid = storePath[1];
      if (req.method === "GET") return handleStoreGet(res, sid);
      if (req.method === "PATCH") return handleStoreUpdate(req, res, sid);
      if (req.method === "DELETE") return handleStoreDelete(res, sid);
    }
    if (req.method === "POST" && url === "/api/debug/resolve-template") {
      if (!(await requireFullAdmin(req, res))) return;
      return handleDebugResolveTemplate(req, res);
    }
    if (req.method === "GET" && url === "/api/admin/metrics") {
      if (!(await requireFullAdmin(req, res))) return;
      return handleAdminMetrics(req, res);
    }
    // Identity endpoints use the lighter requireAdmin gate (admin_token
    // cookie only) — they're the path through the identity modal, so they
    // need to be callable BEFORE the user has a valid claim.
    if (req.method === "GET" && url === "/api/admin/identity") {
      if (!requireAdmin(req, res)) return;
      return handleAdminIdentityGet(req, res);
    }
    if (req.method === "POST" && url === "/api/admin/identity") {
      if (!requireAdmin(req, res)) return;
      return handleAdminIdentitySet(req, res);
    }
    if (req.method === "DELETE" && url === "/api/admin/identity") {
      if (!requireAdmin(req, res)) return;
      return handleAdminIdentityClear(req, res);
    }
    if (req.method === "POST" && url === "/api/jobs") {
      if (!(await requireFullAdmin(req, res))) return;
      return handleJobCreate(req, res);
    }
    if (req.method === "GET" && (url === "/api/jobs" || url.startsWith("/api/jobs?"))) {
      if (!(await requireFullAdmin(req, res))) return;
      return handleJobList(req, res);
    }
    const jobPath = url.match(/^\/api\/jobs\/([^/?]+)(\/[a-z-]+)?(\?.*)?$/);
    if (jobPath) {
      if (!(await requireFullAdmin(req, res))) return;
      const jobId = jobPath[1];
      const sub = jobPath[2];
      if (req.method === "GET" && !sub) return handleJobGet(res, jobId);
      if (req.method === "DELETE" && !sub) return handleJobDelete(res, jobId);
      if (req.method === "GET" && sub === "/stream") return handleJobStream(req, res, jobId);
      if (req.method === "POST" && sub === "/inputs") return handleJobInput(req, res, jobId);
      if (req.method === "POST" && sub === "/notes") return handleJobNotes(req, res, jobId);
      if (req.method === "POST" && sub === "/notes-resolve") return handleJobNoteResolve(req, res, jobId);
      if (req.method === "POST" && sub === "/bundle") return handleJobBundle(req, res, jobId);
    }
    // Assist API — read-only stores/items list + note write. No admin
    // cookie required; assistants live inside the Private Deployment fence.
    if (req.method === "GET" && (url === "/api/assist/stores" || url.startsWith("/api/assist/stores?"))) {
      return handleAssistStores(req, res);
    }
    const assistItems = url.match(/^\/api\/assist\/stores\/([^/?]+)\/items(\?.*)?$/);
    if (assistItems && req.method === "GET") {
      return handleAssistItems(req, res, decodeURIComponent(assistItems[1]));
    }
    const assistNote = url.match(/^\/api\/assist\/stores\/([^/?]+)\/items\/([^/?]+)\/note(\?.*)?$/);
    if (assistNote && req.method === "POST") {
      return handleAssistNote(
        req,
        res,
        decodeURIComponent(assistNote[1]),
        decodeURIComponent(assistNote[2]),
      );
    }
    if (req.method === "GET" && (url === "/api/assist/cards/order" || url.startsWith("/api/assist/cards/order?"))) {
      return handleAssistCardsOrderGet(req, res);
    }
    if (req.method === "POST" && url === "/api/assist/cards/order") {
      return handleAssistCardsOrderSet(req, res);
    }
    const assistDone = url.match(/^\/api\/assist\/stores\/([^/?]+)\/items\/([^/?]+)\/done(\?.*)?$/);
    if (assistDone && req.method === "POST") {
      return handleAssistDone(
        req,
        res,
        decodeURIComponent(assistDone[1]),
        decodeURIComponent(assistDone[2]),
      );
    }
    // Fall-through for any GET: try to serve as a static asset from the UI
    // dir. Covers /components/*, /fonts/*, /mock-*.js, /assist.html, etc.
    // Static assets aren't gated — they're shared between the assist UI
    // (anyone) and the admin UI (cookie-gated by API). No secrets in JS.
    if (req.method === "GET" && req.url && tryServeStatic(req.url, res)) return;

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (e: any) {
    console.error(e);
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(e.message ?? "error");
  }
});

// Startup: run DB migrations, reap stuck jobs, hydrate memory from DB, then
// start the HTTP server. All DB calls are no-ops when DATABASE_URL isn't set.
async function startup() {
  if (isDbEnabled()) {
    try {
      await runMigrations();
      const reaped = await reapStuckJobs();
      const hydrated = await hydrateFromDb();
      console.log(`[startup] db: migrations ok, reaped ${reaped}, hydrated ${hydrated} job(s)`);
    } catch (e) {
      console.warn("[startup] db init failed — continuing in memory-only mode:", e);
      // Trip the kill-switch so subsequent persistence calls don't keep
      // hammering an unreachable host (otherwise every job event during
      // an import racks up another DNS-timeout failure).
      disableDb("startup migrations failed");
    }
  } else {
    console.log("[startup] DATABASE_URL not set — running in memory-only mode");
  }

  server.listen(PORT, HOST, () => {
    const displayHost = HOST === "0.0.0.0" ? "localhost" : HOST;
    console.log(`Migration UI: http://${displayHost}:${PORT}`);
    console.log(`(surface: ${MIME_SURFACE})`);
    if (IS_HOSTED_DEPLOY) console.log("(hosted deploy — import disabled)");
    if (BASIC_AUTH_ENABLED) console.log("(basic auth enabled)");
    console.log(`(ctrl-c to stop)`);
  });
}

void startup();

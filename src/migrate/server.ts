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
  resolveInput,
  setNote,
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
  getStoreById,
  getStoreBySlug,
  listStores,
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
    let account = null;
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

        // Font upload (once per batch). Unresolved fonts are reported but do
        // NOT block import.
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
          for (const u of fontResult.unresolved) {
            emit({
              kind: "warn",
              text: `unresolved font "${u.family}" (${u.reason}) — used by ${u.usedBy.join(", ")}. Add manually in brand kit.`,
            });
          }
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
    const jobPath = url.match(/^\/api\/jobs\/([^/?]+)(\/[a-z]+)?(\?.*)?$/);
    if (jobPath) {
      if (!(await requireFullAdmin(req, res))) return;
      const jobId = jobPath[1];
      const sub = jobPath[2];
      if (req.method === "GET" && !sub) return handleJobGet(res, jobId);
      if (req.method === "DELETE" && !sub) return handleJobDelete(res, jobId);
      if (req.method === "GET" && sub === "/stream") return handleJobStream(req, res, jobId);
      if (req.method === "POST" && sub === "/inputs") return handleJobInput(req, res, jobId);
      if (req.method === "POST" && sub === "/notes") return handleJobNotes(req, res, jobId);
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
    if (IS_HOSTED_DEPLOY) console.log("(hosted deploy — import disabled)");
    if (BASIC_AUTH_ENABLED) console.log("(basic auth enabled)");
    console.log(`(ctrl-c to stop)`);
  });
}

void startup();

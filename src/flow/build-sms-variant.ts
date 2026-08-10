// Build an SMS-signup variant of an email marketing flow: keep the SMS steps,
// their timing (waits), and their conditions exactly; remove the email sends;
// swap the trigger to sms_marketing_signup. One-shot, mirrors import-one.ts.
//
// Why: email_marketing_signup has no phone field, so SMS steps get dropped from
// the email flow (see fix/sms-phone-field-per-schema). This recreates those SMS
// as a parallel sms_marketing_signup flow — "same SMS, same time, same conditions."
//
// Usage:
//   KLAVIYO_API_KEY=… REDO_JWT=… FLOW_ID=… npx tsx src/flow/build-sms-variant.ts
//   DIAGNOSE_ONLY=1 stops before import and dumps the transformed automation.

import { writeFileSync } from "node:fs";
import { fetchAllMetrics } from "../extract-metrics.js";
import { fetchAccount } from "../fetch-account.js";
import { klaviyo } from "../klaviyo.js";
import {
  importFlowRpc,
  decodeJwtAud,
  type ImportProgressEvent,
} from "../migrate/import-rpc.js";
import { MARKETING_TRIGGER_OPTIONS } from "./marketing-trigger-options.js";
import { parseFlow } from "./parser.js";
import { createTemplateResolver } from "./template-resolver.js";
import type { KlaviyoFlow } from "./types.js";

// Remove every step of `dropType` from the automation and re-stitch the graph
// so nothing points at a removed step. Pointer fields: nextId, nextTrueId,
// nextFalseId. Chains are followed (a removed step pointing at another removed
// step resolves to the first surviving step).
function dropStepsByType(automation: any, dropType: string): number {
  const steps: any[] = automation.steps ?? [];
  const byId = new Map<string, any>(steps.map((s) => [s.id, s]));
  const dropped = new Set(steps.filter((s) => s.type === dropType).map((s) => s.id));
  if (dropped.size === 0) return 0;

  // Resolve a pointer past any run of dropped steps (follow their nextId).
  const resolve = (id: string | null | undefined, seen = new Set<string>()): string | null => {
    if (!id || !dropped.has(id)) return id ?? null;
    if (seen.has(id)) return null; // cycle guard
    seen.add(id);
    return resolve(byId.get(id)?.nextId ?? null, seen);
  };

  for (const s of steps) {
    for (const field of ["nextId", "nextTrueId", "nextFalseId"] as const) {
      if (field in s) s[field] = resolve(s[field]);
    }
  }
  automation.steps = steps.filter((s) => !dropped.has(s.id));
  return dropped.size;
}

// Dropping the emails leaves scaffolding that only existed to serve them: wait
// chains that used to space out sends, and splits that used to choose between
// emails. Neither is structure the merchant authored, and both look broken in
// the flow builder (a 20-day wait chain ending in nothing; a branch whose two
// sides do the same thing). The three passes below remove exactly that.
const FLOW_END_ID = "flow_end";
const DUP_SUFFIX = /__dup_\d+$/;
const POINTER_FIELDS = ["nextId", "nextTrueId", "nextFalseId"] as const;
const SEND_TYPES = new Set(["send_sms", "send_email"]);

const stepMap = (automation: any) =>
  new Map<string, any>((automation.steps ?? []).map((s: any) => [s.id, s]));

const targetsOf = (step: any): string[] =>
  POINTER_FIELDS.map((f) => step[f]).filter((v): v is string => typeof v === "string" && !!v);

// Redirect to the shared End block any pointer whose subtree can no longer
// reach a send. Returns the number of pointers cut.
function pruneDeadTails(automation: any): number {
  const byId = stepMap(automation);
  if (!byId.has(FLOW_END_ID)) return 0;
  const memo = new Map<string, boolean>();
  const leadsToSend = (id: string, path = new Set<string>()): boolean => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (path.has(id)) return false; // cycle guard
    const s = byId.get(id);
    if (!s) return false;
    path.add(id);
    const r = SEND_TYPES.has(s.type) || targetsOf(s).some((t) => leadsToSend(t, path));
    path.delete(id);
    memo.set(id, r);
    return r;
  };

  let cut = 0;
  for (const s of byId.values()) {
    for (const f of POINTER_FIELDS) {
      const t = s[f];
      if (typeof t !== "string" || !t || t === FLOW_END_ID) continue;
      if (byId.has(t) && !leadsToSend(t)) {
        s[f] = FLOW_END_ID;
        cut++;
      }
    }
  }
  return cut;
}

// Identity of a subtree, ignoring treeify's __dup_N clone suffix — two branches
// with the same signature are the same branch cloned, so the split between them
// no longer decides anything.
function subtreeSignature(byId: Map<string, any>, id: unknown, path = new Set<string>()): string {
  if (typeof id !== "string" || !id) return "-";
  if (path.has(id)) return "…";
  const s = byId.get(id);
  if (!s) return "-";
  path.add(id);
  const kids = POINTER_FIELDS.filter((f) => f in s)
    .map((f) => `${f}(${subtreeSignature(byId, s[f], path)})`)
    .join(",");
  path.delete(id);
  return `${s.type}#${id.replace(DUP_SUFFIX, "")}[${kids}]`;
}

function collapseIdenticalBranches(automation: any): number {
  const byId = stepMap(automation);
  const gone = new Set<string>();
  for (const s of byId.values()) {
    if (s.type !== "condition" || gone.has(s.id)) continue;
    if (subtreeSignature(byId, s.nextTrueId) !== subtreeSignature(byId, s.nextFalseId)) continue;
    const survivor = s.nextTrueId ?? null;
    for (const p of byId.values()) {
      for (const f of POINTER_FIELDS) if (p[f] === s.id) p[f] = survivor;
    }
    gone.add(s.id);
  }
  automation.steps = automation.steps.filter((s: any) => !gone.has(s.id));
  return gone.size;
}

function pruneUnreachable(automation: any): number {
  const byId = stepMap(automation);
  const live = new Set<string>();
  const visit = (id: string | null | undefined) => {
    if (typeof id !== "string" || !id || live.has(id) || !byId.has(id)) return;
    live.add(id);
    for (const t of targetsOf(byId.get(id))) visit(t);
  };
  visit(automation.steps.find((s: any) => s.type === "trigger")?.id);
  const before = automation.steps.length;
  automation.steps = automation.steps.filter((s: any) => live.has(s.id));
  return before - automation.steps.length;
}

async function main() {
  const key = process.env.KLAVIYO_API_KEY;
  const jwt = process.env.REDO_JWT;
  const flowId = process.env.FLOW_ID;
  const diagnoseOnly = process.env.DIAGNOSE_ONLY === "1";
  if (!key) throw new Error("KLAVIYO_API_KEY not set");
  if (!flowId) throw new Error("FLOW_ID not set");
  if (!jwt && !diagnoseOnly) throw new Error("REDO_JWT not set (or DIAGNOSE_ONLY=1)");

  console.log(`[1/5] metrics…`);
  const metrics = await fetchAllMetrics(key);

  console.log(`[2/5] fetching flow ${flowId}…`);
  const detail = await klaviyo(`/flows/${flowId}/?additional-fields%5Bflow%5D=definition`, key);
  const flow = detail as KlaviyoFlow;
  console.log(`      "${flow.data.attributes.name}"`);

  let account = null;
  try { account = await fetchAccount(key); } catch { /* non-fatal */ }

  console.log(`[3/5] parsing forced to sms_marketing_signup…`);
  const smsTrigger = MARKETING_TRIGGER_OPTIONS.find((o) => o.value === "sms_signup")!.resolution;
  const templateResolver = createTemplateResolver({
    merchantDir: "/tmp/mime-sms-variant",
    account,
    skipAi: true,
    klaviyoApiKey: key,
  });
  const parsed = await parseFlow(flow, metrics, {
    teamId: decodeJwtAud(jwt ?? "") ?? "__TEAM_ID__",
    templateResolver,
    account,
    forcedTrigger: smsTrigger,
  });
  if (!parsed.automation) {
    console.error(`parse failed: ${parsed.skipped?.reason ?? "unknown"}`);
    process.exit(1);
  }
  const automation = parsed.automation;

  console.log(`[4/5] dropping email steps + re-stitching…`);
  const before = automation.steps.length;
  const removed = dropStepsByType(automation, "send_email");
  automation.name = `${automation.name} (SMS)`;
  console.log(`      ${before} → ${automation.steps.length} steps (removed ${removed} email step(s))`);

  if (automation.steps.filter((s: any) => s.type === "send_sms").length === 0) {
    console.log(`\nno send_sms steps in this flow — nothing to build.`);
    return;
  }

  const cutTails = pruneDeadTails(automation);
  const collapsed = collapseIdenticalBranches(automation);
  const orphaned = pruneUnreachable(automation);
  const smsCount = automation.steps.filter((s: any) => s.type === "send_sms").length;
  console.log(
    `      simplify: ${cutTails} dead tail(s) cut, ${collapsed} no-op split(s) collapsed, ` +
      `${orphaned} step(s) dropped → ${automation.steps.length} steps; ${smsCount} send_sms kept`,
  );

  // Sanity: no surviving pointer references a removed/nonexistent step.
  const ids = new Set(automation.steps.map((s: any) => s.id));
  const dangling: string[] = [];
  for (const s of automation.steps) {
    for (const f of ["nextId", "nextTrueId", "nextFalseId"]) {
      const v = (s as any)[f];
      if (typeof v === "string" && v && !ids.has(v)) dangling.push(`${s.id}.${f}→${v}`);
    }
  }
  if (dangling.length) { console.error(`dangling pointers: ${dangling.join(", ")}`); process.exit(1); }
  console.log(`      graph clean (no dangling pointers)`);

  // Every placeholder becomes a real SmsTemplate in the merchant's account, so
  // drop the ones whose send step didn't survive rather than leaving orphans.
  const liveSentinels = new Set(
    automation.steps.filter((s: any) => s.type === "send_sms").map((s: any) => s.templateId),
  );
  const smsTemplates = parsed.placeholderSmsTemplates.filter((t) => liveSentinels.has(t.sentinelId));

  if (diagnoseOnly) {
    const p = `/tmp/mime-sms-variant-${flowId}.json`;
    writeFileSync(p, JSON.stringify(automation, null, 2));
    console.log(`\nDIAGNOSE_ONLY=1 — dumped to ${p}, not importing.`);
    return;
  }

  console.log(`[5/5] importing SMS flow…`);
  const onProgress = (e: ImportProgressEvent) => {
    if (e.kind === "template_created") console.log(`      ✓ sms template "${e.templateName}" → ${e.templateId}`);
    else if (e.kind === "flow_created") console.log(`      ✓ flow "${e.flowName}" → ${e.flowId}`);
    else if (e.kind === "template_failed" || e.kind === "flow_failed") console.log(`      ✗ ${(e as any).error}`);
  };
  const result = await importFlowRpc(
    {
      automation: automation as any, // AdvancedFlow lacks the bundle's index sig (same as import-one)
      warnings: parsed.warnings,
      placeholderTemplates: [], // email templates intentionally dropped
      placeholderSmsTemplates: smsTemplates,
    },
    { jwt: jwt!, serverBase: process.env.REDO_SERVER_BASE, account, onProgress },
  );
  console.log(`\ndone. flow id: ${result.flowId}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

// Delete a previous migration's flows and the templates only they reference.
// Re-running import-one.ts never updates — it creates a fresh flow + templates
// — so a re-run against a store that already holds the last attempt leaves
// duplicates unless the old set goes first.
//
// Usage (dry run lists what would go; CONFIRM=1 deletes):
//   REDO_JWT=... FLOW_IDS=abc,def npx tsx src/flow/cleanup-import.ts
//   REDO_JWT=... FLOW_FILTER="WC | " CONFIRM=1 npx tsx src/flow/cleanup-import.ts
//
// Enabled flows are skipped unless ALLOW_ENABLED=1 — a live flow is the
// merchant's, not a leftover.

import { postMarketingRpc, postRpc } from "../migrate/import-rpc.js";
import type { ImportOptions } from "../migrate/import-rpc.js";
import { fetchStoreState } from "./verify-import.js";

function sendTemplateIds(flow: Record<string, any>): Map<string, "email" | "sms"> {
  const out = new Map<string, "email" | "sms">();
  for (const step of (flow.steps ?? []) as Array<Record<string, any>>) {
    if (step?.type === "send_email" && step.templateId) out.set(String(step.templateId), "email");
    if (step?.type === "send_sms" && step.templateId) out.set(String(step.templateId), "sms");
  }
  return out;
}

async function main() {
  const jwt = process.env.REDO_JWT;
  if (!jwt) {
    console.error("REDO_JWT is required");
    process.exit(1);
  }
  const options: ImportOptions = { jwt, serverBase: process.env.REDO_SERVER_BASE };
  const idFilter = process.env.FLOW_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
  const nameFilter = process.env.FLOW_FILTER?.toLowerCase();
  if (!idFilter?.length && !nameFilter) {
    console.error("FLOW_IDS or FLOW_FILTER is required — this never deletes a whole store");
    process.exit(1);
  }
  const confirm = process.env.CONFIRM === "1";
  const allowEnabled = process.env.ALLOW_ENABLED === "1";

  const state = await fetchStoreState(options);
  const all = [...state.flowsById.values()];
  const targets = all.filter((f) => {
    if (idFilter?.length) return idFilter.includes(String(f._id));
    return String(f.name ?? "").toLowerCase().includes(nameFilter!);
  });
  if (targets.length === 0) {
    console.error("no flows matched");
    process.exit(1);
  }

  const skippedLive = targets.filter((f) => f.enabled && !allowEnabled);
  const doomed = targets.filter((f) => !f.enabled || allowEnabled);
  const doomedIds = new Set(doomed.map((f) => String(f._id)));

  // A template still referenced by a surviving flow stays, whoever created it.
  const keep = new Set<string>();
  for (const f of all) {
    if (doomedIds.has(String(f._id))) continue;
    for (const id of sendTemplateIds(f).keys()) keep.add(id);
  }
  const templates = new Map<string, "email" | "sms">();
  for (const f of doomed) {
    for (const [id, kind] of sendTemplateIds(f)) if (!keep.has(id)) templates.set(id, kind);
  }
  const shared = doomed.flatMap((f) => [...sendTemplateIds(f).keys()]).filter((id) => keep.has(id));

  for (const f of doomed) console.log(`flow     ${f._id}  ${f.name}`);
  for (const [id, kind] of templates) {
    const name = kind === "email" ? state.templatesById.get(id)?.name ?? "?" : "(sms body not readable)";
    console.log(`${kind.padEnd(8)} ${id}  ${name}`);
  }
  for (const f of skippedLive) console.log(`SKIP live ${f._id}  ${f.name}  (set ALLOW_ENABLED=1 to include)`);
  for (const id of shared) console.log(`KEEP shared ${id}  (referenced by a flow outside the set)`);
  console.log(`\n${doomed.length} flow(s), ${templates.size} template(s)${confirm ? "" : " — dry run, set CONFIRM=1 to delete"}`);
  if (!confirm) return;

  let failed = 0;
  for (const f of doomed) {
    try {
      await postRpc("deleteAdvancedFlow", { flowId: String(f._id) }, options);
    } catch (e) {
      failed++;
      console.error(`deleteAdvancedFlow ${f._id} failed: ${(e as Error).message}`);
    }
  }
  for (const [id, kind] of templates) {
    try {
      if (kind === "email") await postMarketingRpc("deleteEmailTemplate", { emailTemplateId: id }, options);
      else await postMarketingRpc("deleteSmsTemplate", { id }, options);
    } catch (e) {
      failed++;
      console.error(`delete ${kind} template ${id} failed: ${(e as Error).message}`);
    }
  }
  console.log(`deleted ${doomed.length - failed > 0 ? doomed.length : 0} flow(s) and ${templates.size} template(s)${failed ? `, ${failed} failure(s)` : ""}`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

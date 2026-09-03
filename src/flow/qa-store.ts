// Full QA pass over a migrated store. Reads the store back, renders every email
// a flow can send, and checks absolute invariants — not "does this match what
// mime parsed", but "would a merchant be happy to send this".
//
// Three tiers, all automated here:
//   structure/logic — dead branches, unreachable steps, live flows, trigger collisions
//   content         — every send step points at a template with sections
//   fidelity        — the RENDERED email: unresolved Liquid, missing unsubscribe,
//                     Klaviyo CDN assets, links back to Klaviyo, stub subjects
//
// Usage:
//   REDO_JWT=... npx tsx src/flow/qa-store.ts
//   REDO_JWT=... FLOW_FILTER="Welcome" npx tsx src/flow/qa-store.ts
//   REDO_JWT=... FLOW_IDS=abc,def QA_JSON=/tmp/qa.json npx tsx src/flow/qa-store.ts
//
// Exits non-zero when anything is broken, so a caller can gate on it.

import { postMarketingRpc } from "../migrate/import-rpc.js";
import type { ImportOptions } from "../migrate/import-rpc.js";
import {
  contentChecks,
  fetchStoreState,
  formatReport,
  scoreChecks,
  type Check,
} from "./verify-import.js";
import {
  activationChecks,
  deadBranchChecks,
  reachabilityChecks,
  renderChecks,
  sendTemplateIds,
  triggerCollisionChecks,
} from "./qa-checks.js";

async function renderTemplate(id: string, options: ImportOptions): Promise<string | null> {
  try {
    const html = await postMarketingRpc("previewEmailTemplate", { templateId: id }, options);
    return typeof html === "string" ? html : null;
  } catch {
    return null;
  }
}

async function main() {
  const jwt = process.env.REDO_JWT;
  if (!jwt) {
    console.error("REDO_JWT is required");
    process.exit(1);
  }
  const options: ImportOptions = { jwt, serverBase: process.env.REDO_SERVER_BASE };
  const nameFilter = process.env.FLOW_FILTER?.toLowerCase();
  const idFilter = process.env.FLOW_IDS?.split(",").map((s) => s.trim()).filter(Boolean);

  // "Imports land inactive" is a rule about *migrated* flows. Unscoped, this
  // walks the merchant's whole store, where their own live flows are supposed
  // to be on — so only enforce activation when a scope was named.
  const scoped = Boolean(idFilter?.length || nameFilter);

  const state = await fetchStoreState(options);
  const allFlows = [...state.flowsById.values()];
  const flows = allFlows.filter((f) => {
    if (idFilter?.length) return idFilter.includes(String(f._id));
    if (nameFilter) return String(f.name ?? "").toLowerCase().includes(nameFilter);
    return true;
  });

  if (flows.length === 0) {
    console.error("no flows matched");
    process.exit(1);
  }

  console.log(
    `QA: ${flows.length} flow(s) of ${allFlows.length} in store, ` +
      `${state.templatesById.size} email template(s)` +
      (scoped ? "" : " — unscoped, skipping the inactive-on-import check") +
      `\n`,
  );

  const perFlow: Array<{ name: string; checks: Check[] }> = [];
  for (const flow of flows.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    perFlow.push({
      name: String(flow.name ?? flow._id),
      checks: [
        ...contentChecks(flow, state.templatesById),
        ...deadBranchChecks(flow),
        ...reachabilityChecks(flow),
        ...(scoped ? activationChecks(flow) : []),
      ],
    });
  }

  // Trigger collisions are a property of the whole store, not one flow: a
  // migrated flow can collide with something that was already there.
  const collisions = triggerCollisionChecks(allFlows, new Set(flows.map((f) => String(f._id))));

  // One render call per distinct template a flow in scope can send.
  const ids = [...sendTemplateIds(flows)];
  console.log(`rendering ${ids.length} template(s)...`);
  const renderResults: Check[] = [];
  for (const id of ids) {
    const tpl = state.templatesById.get(id) as Record<string, any> | undefined;
    const html = await renderTemplate(id, options);
    if (html === null) {
      renderResults.push({
        item: `"${tpl?.name ?? id}" render`,
        dimension: "fidelity",
        verdict: "broken",
        detail: "previewEmailTemplate failed — the template cannot be rendered",
      });
      continue;
    }
    renderResults.push(
      ...renderChecks({ id, name: tpl?.name, subject: tpl?.subject, html }),
    );
  }

  const all = [...perFlow.flatMap((f) => f.checks), ...collisions, ...renderResults];

  console.log("");
  for (const { name, checks } of perFlow) {
    const s = scoreChecks(checks);
    const head = s.scored === 0 ? "  —  " : `${s.score.toFixed(0)}% ${s.grade}`;
    console.log(`${head.padEnd(10)} ${name}`);
    for (const c of checks.filter((c) => c.verdict === "broken")) {
      console.log(`             ✗ ${c.item}: ${c.detail}`);
    }
  }

  console.log(formatReport([...collisions, ...renderResults], scoreChecks(all)));

  const jsonPath = process.env.QA_JSON;
  if (jsonPath) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          flows: perFlow.map(({ name, checks }) => ({ name, checks, score: scoreChecks(checks) })),
          store: { collisions, render: renderResults },
          score: scoreChecks(all),
        },
        null,
        2,
      ),
    );
    console.log(`\nwrote ${jsonPath}`);
  }

  if (all.some((c) => c.verdict === "broken")) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

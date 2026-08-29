// Score an already-migrated store by reading it back. Content-only: it checks
// that every send step in every matched flow points at a message the merchant
// would actually receive. No Klaviyo key needed, no parse to compare against —
// which is exactly what you want when scoring a migration after the fact.
//
// Usage:
//   REDO_JWT=... npx tsx src/flow/score-store.ts
//   REDO_JWT=... FLOW_FILTER="Welcome" npx tsx src/flow/score-store.ts
//   REDO_JWT=... FLOW_IDS=abc,def npx tsx src/flow/score-store.ts

import { contentChecks, formatReport, scoreChecks, fetchStoreState } from "./verify-import.js";

async function main() {
  const jwt = process.env.REDO_JWT;
  if (!jwt) {
    console.error("REDO_JWT is required");
    process.exit(1);
  }
  const options = { jwt, serverBase: process.env.REDO_SERVER_BASE };
  const nameFilter = process.env.FLOW_FILTER?.toLowerCase();
  const idFilter = process.env.FLOW_IDS?.split(",").map((s) => s.trim()).filter(Boolean);

  const state = await fetchStoreState(options);
  const flows = [...state.flowsById.values()].filter((f) => {
    if (idFilter?.length) return idFilter.includes(String(f._id));
    if (nameFilter) return String(f.name ?? "").toLowerCase().includes(nameFilter);
    return true;
  });

  if (flows.length === 0) {
    console.error("no flows matched");
    process.exit(1);
  }

  const all = [];
  console.log(`scoring ${flows.length} flow(s), ${state.templatesById.size} email template(s) in store\n`);
  for (const f of flows.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const checks = contentChecks(f, state.templatesById);
    all.push(...checks);
    const s = scoreChecks(checks);
    const bad = checks.filter((c) => c.verdict === "broken");
    const head = s.scored === 0 ? "  —  (no email sends)" : `${s.score.toFixed(0)}% ${s.grade}`;
    console.log(
      `${head.padEnd(10)} ${String(f.name)}  [${s.clean} ok / ${s.broken} broken` +
        (s.unverified ? ` / ${s.unverified} sms unverified` : "") +
        `]`,
    );
    for (const c of bad) console.log(`             ✗ ${c.item}: ${c.detail}`);
  }

  console.log(formatReport([], scoreChecks(all)).split("\n").slice(-1)[0]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Lists (and optionally re-runs) every flow whose last import didn't land clean
// under a commit that is no longer HEAD — i.e. flows a later code fix would
// now import correctly. This is the gap that left 15 blank emails in Bailey's
// Blossoms: the {{ organization }} fix landed mid-run, the three hard failures
// were re-run by hand, and the three flows that had "succeeded" with blanks
// were not.
//
// Usage:
//   npx tsx src/flow/rerun-stale.ts                 # list what's stale
//   KLAVIYO_API_KEY=... REDO_JWT=... RERUN=1 \
//     npx tsx src/flow/rerun-stale.ts               # re-run them in sequence

import { spawnSync } from "node:child_process";
import { headSha } from "../git-freshness.js";
import { readLedger, staleRuns } from "./run-ledger.js";

const teamId = process.env.TEAM_ID;
const stale = staleRuns(teamId);
const head = headSha();

console.log(`HEAD: ${head}`);
console.log(`ledger: ${readLedger().length} run(s)${teamId ? ` (filtered to team ${teamId})` : ""}`);

if (stale.length === 0) {
  console.log(`\nnothing stale — every degraded run is already on the current commit.`);
  process.exit(0);
}

console.log(`\n${stale.length} flow(s) imported under an older commit and didn't land clean:\n`);
for (const r of stale) {
  const detail = r.status === "blanks" ? `${r.blankCount} blank email(s)` : "no flow created";
  console.log(`  ${r.klaviyoFlowId}  [${r.commit ?? "?"}]  ${detail}`);
  console.log(`      ${r.flowName}`);
}

if (process.env.RERUN !== "1") {
  console.log(`\nRe-run them with:\n  KLAVIYO_API_KEY=... REDO_JWT=... RERUN=1 npx tsx src/flow/rerun-stale.ts`);
  console.log(`\nOr one at a time:`);
  for (const r of stale) {
    console.log(`  FLOW_ID=${r.klaviyoFlowId} npx tsx src/flow/import-one.ts`);
  }
  process.exit(0);
}

// A flow that already exists in Redo will be created a second time by a plain
// re-run. Say so rather than silently duplicating — cleaning up the old copy is
// a merchant-visible call, so it stays with the operator.
const existing = stale.filter((r) => r.redoFlowId);
if (existing.length > 0) {
  console.log(`\nNote: ${existing.length} of these already exist in Redo and will be re-created as duplicates:`);
  for (const r of existing) console.log(`  ${r.redoFlowId}  ${r.flowName}`);
  console.log(`Delete the old copies after verifying the new ones.`);
}

let failed = 0;
for (const [i, r] of stale.entries()) {
  console.log(`\n─── [${i + 1}/${stale.length}] ${r.klaviyoFlowId} ${r.flowName} ───`);
  const res = spawnSync("npx", ["tsx", "src/flow/import-one.ts"], {
    stdio: "inherit",
    env: { ...process.env, FLOW_ID: r.klaviyoFlowId },
  });
  if (res.status !== 0) failed++;
}

console.log(`\n${stale.length - failed}/${stale.length} re-ran clean.`);
process.exit(failed > 0 ? 1 : 0);

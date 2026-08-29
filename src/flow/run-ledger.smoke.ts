/**
 * Smoke test: the run ledger only calls a flow "stale" when re-running it would
 * actually change something — it didn't land clean, AND the code has moved since.
 *
 *   npx tsx src/flow/run-ledger.smoke.ts
 *
 * The case this exists for is Bailey's Blossoms (2026-08-27): the
 * {{ organization }} Liquid fix landed mid-run, the three flows that hard-failed
 * were re-run by hand, and the three that had "succeeded" with 15 blank emails
 * between them were not — because nothing recorded which commit they ran under.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headSha } from "../git-freshness.js";
import { staleRuns, type RunEntry } from "./run-ledger.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function seed(rows: RunEntry[]): void {
  writeFileSync(process.env.RUN_LEDGER_PATH as string, JSON.stringify(rows, null, 2));
}

function row(over: Partial<RunEntry>): RunEntry {
  return {
    teamId: "team1",
    klaviyoFlowId: "AAAAAA",
    flowName: "Flow",
    redoFlowId: "redo1",
    status: "clean",
    blankCount: 0,
    commit: "oldsha",
    at: "2026-08-27T17:00:00Z",
    ...over,
  };
}

async function main() {
  // Point the ledger at a scratch file so the operator's real one is untouched.
  // Stay in the checkout — staleRuns() needs git to resolve HEAD.
  process.env.RUN_LEDGER_PATH = join(
    mkdtempSync(join(tmpdir(), "mime-ledger-")),
    "ledger.json",
  );

  const head = headSha();
  if (!head) fail("no HEAD sha — run this inside the git checkout");

  seed([
    row({ klaviyoFlowId: "BLANKOLD", status: "blanks", blankCount: 8, commit: "oldsha" }),
    row({ klaviyoFlowId: "FAILOLD", status: "failed", redoFlowId: null, commit: "oldsha" }),
    row({ klaviyoFlowId: "BLANKNOW", status: "blanks", blankCount: 3, commit: head }),
    row({ klaviyoFlowId: "CLEANOLD", status: "clean", commit: "oldsha" }),
    row({ klaviyoFlowId: "OTHERTEAM", status: "blanks", blankCount: 1, commit: "oldsha", teamId: "team2" }),
  ]);

  const ids = staleRuns().map((r) => r.klaviyoFlowId).sort();
  if (ids.join(",") !== "BLANKOLD,FAILOLD,OTHERTEAM") {
    fail(`expected BLANKOLD,FAILOLD,OTHERTEAM — got ${ids.join(",") || "(none)"}`);
  }
  console.log("✓ degraded + older commit → stale");
  console.log("✓ degraded under HEAD → not stale (re-running changes nothing yet)");
  console.log("✓ clean under an older commit → not stale");

  const mine = staleRuns("team1").map((r) => r.klaviyoFlowId).sort();
  if (mine.join(",") !== "BLANKOLD,FAILOLD") fail(`team filter: got ${mine.join(",")}`);
  console.log("✓ TEAM_ID filter scopes to one merchant");

  seed([]);
  if (staleRuns().length !== 0) fail("empty ledger should be empty");
  console.log("✓ empty ledger → nothing stale");

  console.log("\nAll run-ledger smoke checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// A flow that imports with blank emails is still "created" — the flow lands in
// Redo with N empty templates wired into it and the run reads like a success.
// When a fix lands mid-run (Bailey's Blossoms, 2026-08-27: the {{ organization }}
// Liquid leak), the flows that already ran keep their blanks, because nothing
// remembers which commit they ran under. This ledger is that memory: one row per
// import, stamped with the commit. `rerun-stale.ts` reads it back.
//
// Local-only state (migrations/ is gitignored) — it describes this operator's
// runs against this merchant, not anything shared.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { headSha } from "../git-freshness.js";

// Read per call, not once at import: RUN_LEDGER_PATH lets a run from a different
// cwd (and the smoke test) point at its own file, and a module-level const would
// freeze the default before anything had a chance to set it.
function ledgerPath(): string {
  return process.env.RUN_LEDGER_PATH ?? "migrations/.run-ledger.json";
}

export interface RunEntry {
  teamId: string;
  klaviyoFlowId: string;
  flowName: string;
  redoFlowId: string | null;
  /** clean = every message imported with content. blanks = flow created but N
   *  emails are empty. failed = no flow created. Only `clean` is done. */
  status: "clean" | "blanks" | "failed";
  blankCount: number;
  commit: string | null;
  at: string;
}

export function readLedger(): RunEntry[] {
  const LEDGER = ledgerPath();
  if (!existsSync(LEDGER)) return [];
  try {
    return JSON.parse(readFileSync(LEDGER, "utf8")) as RunEntry[];
  } catch {
    return [];
  }
}

/** Upsert by (teamId, klaviyoFlowId) — a re-run replaces its own last result
 *  rather than stacking, so the ledger always reads as current state. */
export function recordRun(entry: Omit<RunEntry, "commit" | "at">): void {
  const rows = readLedger().filter(
    (r) => !(r.teamId === entry.teamId && r.klaviyoFlowId === entry.klaviyoFlowId),
  );
  rows.push({ ...entry, commit: headSha(), at: new Date().toISOString() });
  const LEDGER = ledgerPath();
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, JSON.stringify(rows, null, 2));
}

/** Runs worth doing again: anything that didn't land clean, under a commit
 *  that is no longer HEAD. A degraded run under the CURRENT commit is not
 *  stale — re-running it changes nothing until the code does. */
export function staleRuns(teamId?: string): RunEntry[] {
  const head = headSha();
  // Outside a git checkout we can't tell whether the code moved. Reporting
  // every degraded run as stale would push the operator to re-import flows
  // that nothing has fixed yet, so say nothing instead.
  if (head === null) return [];
  return readLedger().filter(
    (r) =>
      r.status !== "clean" &&
      r.commit !== head &&
      (teamId === undefined || r.teamId === teamId),
  );
}

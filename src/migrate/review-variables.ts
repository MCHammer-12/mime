/**
 * Package E4 — REVIEW list aggregation for unresolved Klaviyo variables.
 *
 * Walks every template HTML in a migration directory, parses each, and
 * aggregates the `reviewItems` emitted by `classifyKlaviyoUrl` (in
 * src/parser/url-mapping.ts). Each unique variable is presented once,
 * deduped across templates, with a count of templates affected.
 *
 * For each unknown variable, the user picks:
 *   [M]apped       — Redo has an equivalent dynamic variable. Prompt for
 *                    schemaFieldName, append to `mapped` in the pending JSON.
 *   [U]nsupported  — Redo can't resolve it, template should be blocked.
 *                    Append to `unsupported` in the pending JSON.
 *   [S]kip         — Ephemeral; decide later. Not persisted.
 *   [Q]uit         — Stop early, keep decisions made so far.
 *
 * The pending JSON is NOT folded into src/parser/url-mapping.ts
 * automatically — the engineer hand-edits url-mapping.ts to add entries
 * from the pending file as a follow-up PR, then re-runs parsing.
 *
 * Usage:
 *   npx tsx src/migrate/review-variables.ts <templates-dir> [--pending <file>]
 *
 * Default pending file: ./url-mappings-pending.json (gitignored).
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as readline from "node:readline";
import { argv, stdin, stdout } from "node:process";

import { parseKlaviyoHtml } from "../parser/index.js";

interface AggregatedVar {
  variableName: string;
  count: number; // distinct templates
  exampleContext: string;
  exampleTemplate: string;
  blockTypes: Set<string>;
  seenTemplates: Set<string>;
}

interface MappedDecision {
  variableName: string;
  schemaFieldName: string;
}

interface UnsupportedDecision {
  variableName: string;
  reason: string;
}

interface PendingDecisions {
  mapped: MappedDecision[];
  unsupported: UnsupportedDecision[];
}

const DEFAULT_PENDING_FILE = "url-mappings-pending.json";

async function main(): Promise<void> {
  const args = argv.slice(2);
  const templatesDir = args[0];
  if (!templatesDir || templatesDir.startsWith("-")) {
    console.error(
      "Usage: npx tsx src/migrate/review-variables.ts <templates-dir> [--pending <file>]",
    );
    process.exit(1);
  }
  let pendingPath = DEFAULT_PENDING_FILE;
  const pi = args.indexOf("--pending");
  if (pi >= 0 && args[pi + 1]) pendingPath = args[pi + 1]!;

  const aggregated = aggregateReviewItems(templatesDir);
  if (aggregated.length === 0) {
    console.log("No unknown variables found. Nothing to review.");
    return;
  }

  console.log(
    `Found ${aggregated.length} unknown variable${aggregated.length === 1 ? "" : "s"} across templates in ${templatesDir}:\n`,
  );
  aggregated.forEach((v, i) => {
    const blocks = [...v.blockTypes].sort().join(", ");
    console.log(
      `  ${i + 1}. ${v.variableName}  (${v.count} template${v.count === 1 ? "" : "s"}, blocks: ${blocks})`,
    );
  });
  console.log();

  const pending = loadPending(pendingPath);
  const alreadyClassified = new Set<string>([
    ...pending.mapped.map((m) => m.variableName),
    ...pending.unsupported.map((u) => u.variableName),
  ]);

  const ask = makePrompter();
  try {
    for (const v of aggregated) {
      if (alreadyClassified.has(v.variableName)) {
        console.log(
          `[already in ${pendingPath}] ${v.variableName} — skipping`,
        );
        continue;
      }

      console.log(`\n— ${v.variableName} —`);
      console.log(`  used in ${v.count} template${v.count === 1 ? "" : "s"}`);
      console.log(`  block types: ${[...v.blockTypes].sort().join(", ")}`);
      console.log(`  example context: ${truncate(v.exampleContext, 120)}`);
      console.log(`  example template: ${v.exampleTemplate}`);

      const rawChoice = await ask.question(
        "  [M]apped / [U]nsupported / [S]kip / [Q]uit > ",
      );
      if (rawChoice === null) {
        console.log("\n  stdin closed — stopping.");
        break;
      }
      const choice = rawChoice.trim().toLowerCase();

      if (choice === "q") {
        console.log("  quitting.");
        break;
      }
      if (choice === "s" || choice === "") {
        console.log("  skipped.");
        continue;
      }
      if (choice === "m") {
        const suggested = toCamelCase(v.variableName);
        const sfnRaw = await ask.question(
          `  schemaFieldName (default "${suggested}"): `,
        );
        if (sfnRaw === null) {
          console.log("\n  stdin closed — stopping.");
          break;
        }
        const sfn = sfnRaw.trim() || suggested;
        pending.mapped.push({
          variableName: v.variableName,
          schemaFieldName: sfn,
        });
        savePending(pendingPath, pending);
        console.log(`  saved as mapped → ${sfn}`);
        continue;
      }
      if (choice === "u") {
        const reasonRaw = await ask.question(
          `  reason (default "${v.variableName}"): `,
        );
        if (reasonRaw === null) {
          console.log("\n  stdin closed — stopping.");
          break;
        }
        const reason = reasonRaw.trim() || v.variableName;
        pending.unsupported.push({
          variableName: v.variableName,
          reason,
        });
        savePending(pendingPath, pending);
        console.log(`  saved as unsupported (${reason}).`);
        continue;
      }
      console.log(`  unrecognized choice "${choice}" — treating as skip.`);
    }
  } finally {
    ask.close();
  }

  console.log(`\nDone. Pending decisions written to ${pendingPath}:`);
  console.log(`  mapped:      ${pending.mapped.length}`);
  console.log(`  unsupported: ${pending.unsupported.length}`);
  console.log(
    `\nNext step: fold these into src/parser/url-mapping.ts (mapKlaviyoUrlToSchemaField + UNSUPPORTED_VARIABLES), then re-run the migration.`,
  );
}

function aggregateReviewItems(dir: string): AggregatedVar[] {
  const map = new Map<string, AggregatedVar>();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".html"));
  } catch (e) {
    console.error(`cannot read templates dir ${dir}: ${(e as Error).message}`);
    process.exit(1);
  }
  for (const f of files) {
    let html: string;
    try {
      html = readFileSync(join(dir, f), "utf-8");
    } catch (e) {
      console.warn(`read failed for ${f}: ${(e as Error).message}`);
      continue;
    }
    let res;
    try {
      res = parseKlaviyoHtml(html);
    } catch (e) {
      console.warn(`parse failed for ${f}: ${(e as Error).message}`);
      continue;
    }
    for (const item of res.reviewItems) {
      const existing = map.get(item.variableName);
      if (existing) {
        existing.seenTemplates.add(f);
        existing.blockTypes.add(String(item.blockType));
      } else {
        map.set(item.variableName, {
          variableName: item.variableName,
          count: 0,
          exampleContext: item.context,
          exampleTemplate: f,
          blockTypes: new Set([String(item.blockType)]),
          seenTemplates: new Set([f]),
        });
      }
    }
  }
  const out: AggregatedVar[] = [];
  for (const v of map.values()) {
    v.count = v.seenTemplates.size;
    out.push(v);
  }
  out.sort(
    (a, b) => b.count - a.count || a.variableName.localeCompare(b.variableName),
  );
  return out;
}

/**
 * Line-queue prompter. `rl.question()` (both callback + promise flavours)
 * misbehaves once stdin is piped from a file — the second invocation
 * never resolves because readline closes as soon as the underlying
 * stream ends, even while earlier-buffered lines are still unread.
 *
 * This version listens on 'line' and queues every line as it arrives,
 * handing them out one-at-a-time to the caller. On 'close', any pending
 * consumer (and all future asks) resolve to null so the loop can bail.
 */
function makePrompter(): {
  question: (q: string) => Promise<string | null>;
  close: () => void;
} {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const lineBuffer: string[] = [];
  const waiters: Array<(value: string | null) => void> = [];
  let closed = false;

  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lineBuffer.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()!(null);
  });

  return {
    question: (q) =>
      new Promise((resolve) => {
        stdout.write(q);
        if (lineBuffer.length > 0) return resolve(lineBuffer.shift()!);
        if (closed) return resolve(null);
        waiters.push(resolve);
      }),
    close: () => {
      if (!closed) rl.close();
    },
  };
}

function loadPending(path: string): PendingDecisions {
  if (!existsSync(path)) return { mapped: [], unsupported: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return {
      mapped: Array.isArray(raw.mapped) ? raw.mapped : [],
      unsupported: Array.isArray(raw.unsupported) ? raw.unsupported : [],
    };
  } catch (e) {
    console.warn(
      `couldn't parse ${path} (${(e as Error).message}); starting fresh.`,
    );
    return { mapped: [], unsupported: [] };
  }
}

function savePending(path: string, p: PendingDecisions): void {
  writeFileSync(path, JSON.stringify(p, null, 2) + "\n");
}

function toCamelCase(varName: string): string {
  const parts = varName.split(/[._\s]+/).filter(Boolean);
  if (parts.length === 0) return varName;
  return (
    parts[0]!.toLowerCase() +
    parts
      .slice(1)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
      .join("")
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Post-import readback: pull the flow back out of Redo and diff it against what
// the parser said it should be.
//
// The gap this closes: mime's import path reports what it *sent*, not what
// landed. Bailey's Blossoms (2026-08-27) imported 11 flows and reported
// success on 8 of them while 15 of their 37 emails were empty — the create
// call had 400'd, a blank placeholder went in its place, and the run still
// printed "done." Reading the store back is the only way to score a migration
// on what the merchant will actually see.
//
// Verdicts, per item:
//   clean      — matches what the parse expected
//   degraded   — landed, but a merchant would notice something off
//   broken     — missing, blank, or wired to nothing
//   unverified — no read API exists for it (SMS bodies); excluded from the score
//
// Score = (clean + 0.5 x degraded) / (clean + degraded + broken).

export type Verdict = "clean" | "degraded" | "broken" | "unverified";
export type Dimension = "structure" | "content" | "logic" | "fidelity";

export interface Check {
  item: string;
  dimension: Dimension;
  verdict: Verdict;
  detail: string;
}

export interface ExpectedFlow {
  name: string;
  steps: Array<Record<string, any>>;
  warnings: Array<{ kind: string; message: string }>;
}

/** A template as returned by getEmailTemplates. */
export interface RedoTemplate {
  _id: string;
  name?: string;
  sections?: unknown[];
}

const OBJECT_ID = /^[0-9a-f]{24}$/;

// Warning kinds the parser emits. `gate` and `skip` are routine bookkeeping;
// the rest each describe something the merchant would notice, so they cost
// half an item apiece rather than being swallowed by a passing structural check.
const MERCHANT_VISIBLE_WARNINGS = new Set([
  "degraded-mapping",
  "requires-review",
  "skipped-flow",
  "skipped-step",
  "unsupported-action",
  "unsupported-trigger",
]);

/**
 * Does every send step in this flow point at a message a merchant would
 * actually receive? Split out from verifyFlow because it needs no parse to
 * compare against — an already-migrated store can be scored on content alone.
 */
export function contentChecks(
  actual: Record<string, any>,
  templatesById: Map<string, RedoTemplate>,
): Check[] {
  const checks: Check[] = [];
  const label = String(actual.name ?? actual._id);
  const steps: Array<Record<string, any>> = actual.steps ?? [];

  steps.forEach((step, i) => {
    const type = String(step.type);
    if (type !== "send_email" && type !== "send_sms") return;
    const item = `step[${i}] ${type} in "${label}"`;
    const id = String(step.templateId ?? "");

    if (!id || id.startsWith("__PLACEHOLDER_") || !OBJECT_ID.test(id)) {
      checks.push({
        item,
        dimension: "content",
        verdict: "broken",
        detail: `templateId is "${id || "(empty)"}" — points at nothing`,
      });
      return;
    }

    if (type === "send_sms") {
      // redoapp exposes createSmsTemplate / deleteSmsTemplate but no read RPC,
      // so the body is unreachable from here. Say so instead of scoring it
      // clean on the strength of a well-formed id.
      checks.push({
        item,
        dimension: "content",
        verdict: "unverified",
        detail: `wired to ${id}; SMS bodies have no read RPC`,
      });
      return;
    }

    const tpl = templatesById.get(id);
    if (!tpl) {
      checks.push({
        item,
        dimension: "content",
        verdict: "broken",
        detail: `templateId ${id} is not a template in this store`,
      });
      return;
    }
    const sections = tpl.sections?.length ?? 0;
    const isPlaceholder = String(tpl.name ?? "").startsWith("[Placeholder]");
    if (isPlaceholder || sections === 0) {
      checks.push({
        item,
        dimension: "content",
        verdict: "broken",
        detail: isPlaceholder
          ? `"${tpl.name}" is a blank placeholder — the real template failed to create`
          : `"${tpl.name}" has no sections — the email is empty`,
      });
      return;
    }
    checks.push({
      item,
      dimension: "content",
      verdict: "clean",
      detail: `"${tpl.name}" — ${sections} section(s)`,
    });
  });

  return checks;
}

/**
 * Diff one imported flow against its parse. Pure — `actual` is the flow doc
 * from getAdvancedFlows, `templatesById` the store's email templates keyed by
 * _id. Returns one Check per scoreable item.
 */
export function verifyFlow(
  expected: ExpectedFlow,
  actual: Record<string, any> | null,
  templatesById: Map<string, RedoTemplate>,
): Check[] {
  const checks: Check[] = [];
  const label = expected.name;

  if (!actual) {
    return [
      {
        item: `flow "${label}"`,
        dimension: "structure",
        verdict: "broken",
        detail: "not found in Redo — the import did not land",
      },
    ];
  }

  checks.push({
    item: `flow "${label}"`,
    dimension: "structure",
    verdict: "clean",
    detail: `exists as ${actual._id}`,
  });

  const actualSteps: Array<Record<string, any>> = actual.steps ?? [];
  const expectedTypes = expected.steps.map((s) => String(s.type));
  const actualTypes = actualSteps.map((s) => String(s.type));

  if (expectedTypes.join(">") !== actualTypes.join(">")) {
    checks.push({
      item: `flow "${label}" step graph`,
      dimension: "structure",
      verdict: "broken",
      detail: `expected ${expectedTypes.length} steps [${expectedTypes.join(", ")}], got ${actualTypes.length} [${actualTypes.join(", ")}]`,
    });
  } else {
    checks.push({
      item: `flow "${label}" step graph`,
      dimension: "structure",
      verdict: "clean",
      detail: `${actualTypes.length} steps, types match`,
    });
  }

  checks.push(...contentChecks(actual, templatesById));

  // Trigger-level sending rules. Klaviyo's re-entry rules map onto the Redo
  // trigger step; losing them silently re-mails people who already converted.
  const expectedTrigger = expected.steps.find((s) => s.type === "trigger");
  const actualTrigger = actualSteps.find((s) => s.type === "trigger");
  if (expectedTrigger && actualTrigger) {
    for (const field of ["frequencyCap", "shouldSkipSmartSending", "skipConditions"]) {
      const want = (expectedTrigger as any)[field];
      if (want === undefined || want === null) continue;
      const got = (actualTrigger as any)[field];
      const same = JSON.stringify(want) === JSON.stringify(got);
      checks.push({
        item: `trigger.${field} in "${label}"`,
        dimension: "logic",
        verdict: same ? "clean" : "broken",
        detail: same
          ? `matches (${JSON.stringify(want)})`
          : `expected ${JSON.stringify(want)}, got ${JSON.stringify(got ?? null)}`,
      });
    }
  }

  for (const w of expected.warnings) {
    if (!MERCHANT_VISIBLE_WARNINGS.has(w.kind)) continue;
    checks.push({
      item: `${w.kind} in "${label}"`,
      dimension: "logic",
      verdict: "degraded",
      detail: w.message,
    });
  }

  return checks;
}

export interface Score {
  clean: number;
  degraded: number;
  broken: number;
  unverified: number;
  scored: number;
  score: number;
  grade: string;
}

/** A→F on the same bands the migration scorecard uses. */
export function gradeFor(score: number): string {
  if (score >= 95) return "A";
  if (score >= 85) return "B";
  if (score >= 70) return "C";
  if (score >= 50) return "D";
  return "F";
}

export function scoreChecks(checks: Check[]): Score {
  const n = (v: Verdict) => checks.filter((c) => c.verdict === v).length;
  const clean = n("clean");
  const degraded = n("degraded");
  const broken = n("broken");
  const unverified = n("unverified");
  const scored = clean + degraded + broken;
  const score = scored === 0 ? 0 : ((clean + 0.5 * degraded) / scored) * 100;
  return {
    clean,
    degraded,
    broken,
    unverified,
    scored,
    score,
    grade: gradeFor(score),
  };
}

export function formatReport(checks: Check[], score: Score): string {
  const lines: string[] = [];
  const bad = checks.filter((c) => c.verdict === "broken");
  const meh = checks.filter((c) => c.verdict === "degraded");
  const unk = checks.filter((c) => c.verdict === "unverified");

  if (bad.length) {
    lines.push(`\nBROKEN (${bad.length}):`);
    for (const c of bad) lines.push(`  ✗ ${c.item}\n      ${c.detail}`);
  }
  if (meh.length) {
    lines.push(`\nDEGRADED (${meh.length}) — landed, needs a human look:`);
    for (const c of meh) lines.push(`  ~ ${c.item}\n      ${c.detail}`);
  }
  if (unk.length) {
    lines.push(`\nUNVERIFIED (${unk.length}) — excluded from the score:`);
    for (const c of unk) lines.push(`  ? ${c.item}: ${c.detail}`);
  }
  lines.push(
    `\nSCORE ${score.score.toFixed(0)}% (${score.grade})  ` +
      `clean ${score.clean} / degraded ${score.degraded} / broken ${score.broken}` +
      (score.unverified ? ` / unverified ${score.unverified}` : ""),
  );
  return lines.join("\n");
}

// ─── live readback ─────────────────────────────────────────────────────────

import { postRpc, postMarketingRpc } from "../migrate/import-rpc.js";
import type { ImportOptions } from "../migrate/import-rpc.js";

export interface StoreState {
  flowsById: Map<string, Record<string, any>>;
  templatesById: Map<string, RedoTemplate>;
}

/** One round trip each for flows and email templates — enough to diff a whole
 *  migration, so callers fetch once and verify every flow against it. */
export async function fetchStoreState(options: ImportOptions): Promise<StoreState> {
  const flowsRes = await postRpc(
    "getAdvancedFlows",
    { getUsers: false, includeMetrics: false, includeOriginFlows: false },
    options,
  );
  const flows: Array<Record<string, any>> = flowsRes?.advancedFlows ?? [];
  const templates: RedoTemplate[] = await postMarketingRpc("getEmailTemplates", {}, options);

  return {
    flowsById: new Map(flows.map((f) => [String(f._id), f])),
    templatesById: new Map((templates ?? []).map((t) => [String(t._id), t])),
  };
}

/** Read one flow back and score it. Used by import-one.ts right after an
 *  import, and by the standalone CLI against an already-migrated store. */
export async function verifyImportedFlow(
  redoFlowId: string,
  expected: ExpectedFlow,
  options: ImportOptions,
): Promise<{ checks: Check[]; score: Score }> {
  const state = await fetchStoreState(options);
  const checks = verifyFlow(expected, state.flowsById.get(redoFlowId) ?? null, state.templatesById);
  return { checks, score: scoreChecks(checks) };
}

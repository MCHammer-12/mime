/**
 * Smoke test for the survey / custom-event trigger handling (Rufskin Y7HwZ3).
 *
 *   npx tsx src/flow/survey-trigger.smoke.ts
 *
 * Two guarantees:
 *  1. An unknown custom metric (e.g. "Survey Response Completed") resolves to
 *     NULL (skip → trigger picker), never to a real trigger like order_fulfilled.
 *     A survey event silently becoming an order-fulfillment flow would fire on
 *     the wrong event if the operator enabled it. (Michael's decision 2026-06-12:
 *     unknown custom-event metrics always go to the picker, never silent-default.)
 *  2. A present-but-untranslatable trigger_filter is surfaced by NAME (e.g.
 *     `survey_code equals 689d034ddda30`) so the operator can re-create it,
 *     instead of a vague "has a trigger_filter" note.
 */
import { resolveTrigger, summarizeTriggerFilter } from "./trigger-mapping.js";
import { parseFlow } from "./parser.js";
import type { KlaviyoFlow } from "./types.js";
import type { MetricLookup } from "../extract-metrics.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const surveyFilter = {
  condition_groups: [
    {
      conditions: [
        { type: "event-property", field: "survey_code", filter: { type: "string", operator: "equals", value: "689d034ddda30" } },
      ],
    },
  ],
};

function metricFlow(triggerFilter: unknown): KlaviyoFlow {
  return {
    data: {
      id: "flow-survey",
      type: "flow",
      attributes: {
        name: "SURVEY COMPLETED (GV support - draft)",
        status: "draft",
        definition: { triggers: [{ type: "metric", id: "m1", trigger_filter: triggerFilter }], actions: [] },
      },
    },
  } as unknown as KlaviyoFlow;
}
const metricsFor = (name: string): MetricLookup => ({ m1: { id: "m1", name, integration_name: "Survey App" } as any });

function testUnknownMetricGoesToPicker() {
  for (const name of ["Survey Response Completed", "Survey Completed", "Quiz Finished", "Loyalty Points Earned"]) {
    const warnings: any[] = [];
    const r = resolveTrigger(metricFlow(surveyFilter), metricsFor(name), warnings);
    if (r !== null) fail(`"${name}" resolved to ${JSON.stringify(r)} — expected null (skip→picker), NEVER a real trigger`);
    const warned = warnings.some((w) => /no Redo trigger equivalent/.test(w.message ?? ""));
    if (!warned) fail(`"${name}" → null but no unsupported-trigger warning`);
  }
  console.log("✓ unknown custom/survey metrics → null (skip→picker), never order_fulfilled");
}

function testKnownOrderMetricStillResolves() {
  // Regression: tightening must not break real order metrics.
  const warnings: any[] = [];
  const r = resolveTrigger(metricFlow(null), metricsFor("Fulfilled Order"), warnings);
  if (!r || r.key !== "order_fulfilled") fail(`"Fulfilled Order" should still resolve to order_fulfilled, got ${JSON.stringify(r)}`);
  console.log("✓ real order metric (Fulfilled Order) still resolves to order_fulfilled");
}

function testSummarizeTriggerFilter() {
  if (summarizeTriggerFilter(surveyFilter) !== "survey_code equals 689d034ddda30") {
    fail(`survey filter summary wrong: ${summarizeTriggerFilter(surveyFilter)}`);
  }
  // AND within a group, OR across groups.
  const multi = {
    condition_groups: [
      { conditions: [
        { field: "survey_code", filter: { operator: "equals", value: "A" } },
        { field: "score", filter: { operator: "greater-than", value: "3" } },
      ] },
      { conditions: [{ field: "tier", filter: { operator: "equals", value: "gold" } }] },
    ],
  };
  const got = summarizeTriggerFilter(multi);
  if (got !== "survey_code equals A AND score greater-than 3 OR tier equals gold") {
    fail(`multi-condition summary wrong: ${got}`);
  }
  if (summarizeTriggerFilter(null) !== null) fail("null filter should summarize to null");
  if (summarizeTriggerFilter({}) !== null) fail("empty filter should summarize to null");
  console.log("✓ summarizeTriggerFilter names the filter (AND/OR), null on empty");
}

async function testParseSurfacesNamedFilter() {
  // When a trigger DOES resolve (operator forced one / a known metric) and it
  // carries a trigger_filter, parseFlow must surface the filter BY NAME.
  const flow = metricFlow(surveyFilter);
  const r = await parseFlow(flow, metricsFor("Fulfilled Order"), { teamId: "team-x" });
  const w = r.warnings.find((x) => x.message.includes("trigger_filter"));
  if (!w) fail("expected a trigger_filter review warning when a filter is present");
  if (!w.message.includes("survey_code equals 689d034ddda30")) {
    fail(`trigger_filter warning must name the filter, got: ${w.message}`);
  }
  console.log("✓ parseFlow surfaces the trigger_filter by name (actionable warning)");
}

async function main() {
  testUnknownMetricGoesToPicker();
  testKnownOrderMetricStillResolves();
  testSummarizeTriggerFilter();
  await testParseSurfacesNamedFilter();
  console.log("\nAll survey-trigger smoke checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Smoke test for the flow-level profile_filter translator.
 *
 *   npx tsx src/flow/flow-profile-filter.smoke.ts
 *
 * Klaviyo flows carry a top-level `definition.profile_filter` that says
 * "only run for profiles matching X". Redo expresses this as SKIP
 * conditions on the trigger step — semantically inverted via De Morgan.
 * Klaviyo groups are AND'ed, conditions inside a group are OR'ed, and
 * Redo's skipConditions are OR'ed, so every group becomes one inline-
 * segment in mode "AND". These tests pin that for the shapes that show up
 * in production merchant data:
 *
 *   - Single group, single condition (Charlie 1 Horse UN3tf7)
 *   - Multi-group, single condition each (Charlie 1 Horse WV7RZ5)
 *   - Multi-group with a multi-condition group (one skip per group)
 *   - "where Flow equals X" metric filters (Jack Henry UrP3Br)
 *   - Unsupported condition types (warn, skip)
 *   - Empty profile_filter (no skips)
 */
import { translateFlowProfileFilter } from "./condition-mapping.js";
import type { MetricLookup } from "../extract-metrics.js";
import type { ParseWarning } from "./types.js";

const metrics: MetricLookup = {
  "VCkQXS": {
    id: "VCkQXS", name: "Placed Order",
    integration_name: "Shopify", integration_category: null,
    integration_key: null, created: null,
  },
  "UZjNmf": {
    id: "UZjNmf", name: "Checkout Started",
    integration_name: "Shopify", integration_category: null,
    integration_key: null, created: null,
  },
  "UDH6sQ": {
    id: "UDH6sQ", name: "Received Email",
    integration_name: "Klaviyo", integration_category: null,
    integration_key: null, created: null,
  },
};

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

function zeroTimes(metric_id: string, timeframe_filter?: unknown, metric_filters?: unknown) {
  return {
    type: "profile-metric",
    metric_id,
    measurement: "count",
    measurement_filter: { type: "numeric", operator: "equals", value: 0 },
    ...(timeframe_filter ? { timeframe_filter } : {}),
    ...(metric_filters ? { metric_filters } : {}),
  };
}

// ─── Empty / absent ──────────────────────────────────────────────────────
{
  const warnings: ParseWarning[] = [];
  assert(
    translateFlowProfileFilter(null, metrics, warnings).length === 0,
    "null profile_filter → no skips",
  );
  assert(warnings.length === 0, "null profile_filter pushes no warnings");

  assert(
    translateFlowProfileFilter({ condition_groups: [] }, metrics, warnings).length === 0,
    "empty condition_groups → no skips",
  );

  assert(
    translateFlowProfileFilter(
      { condition_groups: [{ conditions: [] }] },
      metrics,
      warnings,
    ).length === 0,
    "group with 0 conditions → no skips",
  );
}

// ─── Single group, single condition (UN3tf7 shape) ──────────────────────
{
  const warnings: ParseWarning[] = [];
  const pf = { condition_groups: [{ conditions: [zeroTimes("VCkQXS")] }] };
  const result = translateFlowProfileFilter(pf, metrics, warnings) as any[];
  assert(result.length === 1, `single group → 1 skip, got ${result.length}`);
  assert(
    result[0].dataSource === "inline-segment",
    `dataSource is inline-segment, got ${result[0].dataSource}`,
  );
  assert(
    result[0].inlineSegment.mode === "AND",
    `group skip uses AND mode (De Morgan of within-group OR), got ${result[0].inlineSegment.mode}`,
  );
  assert(
    result[0].inlineSegment.conditions.length === 1,
    `1 inverted condition, got ${result[0].inlineSegment.conditions.length}`,
  );
  const c = result[0].inlineSegment.conditions[0];
  assert(
    c.activityType === "order-placed",
    `activityType resolved via metric lookup, got ${c.activityType}`,
  );
  assert(
    c.count.type === "at_least_once",
    `count operator inverted (equals 0 → at_least_once), got ${JSON.stringify(c.count)}`,
  );
  assert(warnings.length === 0, `no warnings, got ${JSON.stringify(warnings)}`);
}

// ─── Multi-group, single condition each (WV7RZ5 shape) ──────────────────
{
  const warnings: ParseWarning[] = [];
  const pf = {
    condition_groups: [
      { conditions: [zeroTimes("UZjNmf")] },
      { conditions: [zeroTimes("VCkQXS")] },
    ],
  };
  const result = translateFlowProfileFilter(pf, metrics, warnings) as any[];
  assert(result.length === 2, `AND'd groups → one skip per group, got ${result.length}`);
  assert(
    result.every((s) => s.inlineSegment.mode === "AND" && s.inlineSegment.conditions.length === 1),
    `each skip is a 1-condition AND segment, got ${JSON.stringify(result)}`,
  );
  const activities = result.map((s) => s.inlineSegment.conditions[0].activityType).sort();
  assert(
    activities[0] === "checkout-started" && activities[1] === "order-placed",
    `activities are checkout-started + order-placed, got ${JSON.stringify(activities)}`,
  );
}

// ─── profile-not-in-flow drops silently (handled as frequencyCap) ───────
{
  const warnings: ParseWarning[] = [];
  const pf = {
    condition_groups: [
      { conditions: [{ type: "profile-not-in-flow" }] },
    ],
  };
  const result = translateFlowProfileFilter(pf, metrics, warnings);
  assert(
    result.length === 0,
    "not-in-flow-only profile_filter → no skips (nothing left to emit)",
  );
  assert(
    warnings.length === 0,
    `profile-not-in-flow is translated natively as trigger.frequencyCap, so it must not warn — got ${JSON.stringify(warnings)}`,
  );
}

// ─── Unsupported condition type (profile-property) warns + skips ────────
{
  const warnings: ParseWarning[] = [];
  const pf = {
    condition_groups: [
      { conditions: [{ type: "profile-property" }] },
    ],
  };
  const result = translateFlowProfileFilter(pf, metrics, warnings);
  assert(
    result.length === 0,
    "unsupported-only profile_filter → no skips",
  );
  assert(
    warnings.some((w) => w.message.includes("profile-property")),
    "warning mentions the unsupported type",
  );
}

// ─── Multi-group with a multi-condition (OR'd) group ────────────────────
{
  const warnings: ParseWarning[] = [];
  const pf = {
    condition_groups: [
      { conditions: [
        zeroTimes("VCkQXS"),
        { type: "profile-metric", metric_id: "UZjNmf", measurement: "count",
          measurement_filter: { type: "numeric", operator: "greater-than", value: 5 } },
      ] },
      { conditions: [zeroTimes("UZjNmf")] },
    ],
  };
  const result = translateFlowProfileFilter(pf, metrics, warnings) as any[];
  assert(result.length === 2, `2 groups → 2 skips, got ${result.length}`);
  assert(
    result[0].inlineSegment.mode === "AND" && result[0].inlineSegment.conditions.length === 2,
    `OR'd group inverts to a 2-condition AND segment, got ${JSON.stringify(result[0])}`,
  );
  const gt = result[0].inlineSegment.conditions[1];
  assert(
    gt.count.type === "at_most_n" && gt.count.n === 5,
    `greater-than 5 inverts to at_most_n 5, got ${JSON.stringify(gt.count)}`,
  );
  assert(
    result[1].inlineSegment.conditions.length === 1,
    `second group keeps its own skip, got ${JSON.stringify(result[1])}`,
  );
  assert(warnings.length === 0, `no warnings, got ${JSON.stringify(warnings)}`);
}

// ─── Unknown metric id → warn + skip ────────────────────────────────────
{
  const warnings: ParseWarning[] = [];
  const pf = { condition_groups: [{ conditions: [zeroTimes("UNKNOWN")] }] };
  const result = translateFlowProfileFilter(pf, metrics, warnings);
  assert(result.length === 0, "unresolvable metric → no skips");
  assert(
    warnings.some((w) => w.message.includes("UNKNOWN")),
    "warning calls out the unknown metric id",
  );
}

// ─── "where Flow equals X" metric filter (UrP3Br shape) ─────────────────
const flowStart = { operator: "flow-start" };
const last7Days = { operator: "in-the-last", unit: "day", quantity: 7 };
const fromFlow = (id: string) => [
  { property: "$flow", filter: { operator: "equals", value: id } },
];
const flowIdMap = { WvHXtk: "6aa37ed0660dfe9e55551cda" };
{
  const warnings: ParseWarning[] = [];
  const pf = {
    condition_groups: [
      { conditions: [zeroTimes("VCkQXS", flowStart)] },
      { conditions: [zeroTimes("UDH6sQ", last7Days, fromFlow("WvHXtk"))] },
    ],
  };
  const result = translateFlowProfileFilter(pf, metrics, warnings, flowIdMap) as any[];
  assert(result.length === 2, `2 groups → 2 skips, got ${result.length}`);
  const placed = result[0].inlineSegment.conditions[0];
  assert(
    placed.timeframe.type === "automation-start",
    `flow-start → automation-start, got ${JSON.stringify(placed.timeframe)}`,
  );
  const received = result[1].inlineSegment.conditions[0];
  assert(
    received.activityType === "received-email" && received.count.type === "at_least_once",
    `received-email at_least_once, got ${JSON.stringify(received)}`,
  );
  assert(
    received.timeframe.type === "before-now-relative" &&
      received.timeframe.value === 7 &&
      received.timeframe.units === "day",
    `in-the-last 7 days → before-now-relative 7 day, got ${JSON.stringify(received.timeframe)}`,
  );
  assert(
    JSON.stringify(received.whereConditions) === JSON.stringify([{
      type: "token",
      dimension: "automation",
      comparison: { type: "token", operator: "ANY", values: ["6aa37ed0660dfe9e55551cda"] },
    }]),
    `$flow equals → automation token whereCondition on the Redo flow id, got ${JSON.stringify(received.whereConditions)}`,
  );
  assert(warnings.length === 0, `no warnings, got ${JSON.stringify(warnings)}`);
}

// ─── "where Flow equals X" with X not imported yet → warn + drop group ──
{
  const warnings: ParseWarning[] = [];
  const pf = {
    condition_groups: [
      { conditions: [zeroTimes("VCkQXS", flowStart)] },
      { conditions: [zeroTimes("UDH6sQ", last7Days, fromFlow("WbnmfC"))] },
    ],
  };
  const result = translateFlowProfileFilter(pf, metrics, warnings, flowIdMap) as any[];
  assert(
    result.length === 1 && result[0].inlineSegment.conditions[0].activityType === "order-placed",
    `unresolved $flow drops only its own group, got ${JSON.stringify(result)}`,
  );
  assert(
    warnings.length === 1 && warnings[0].message.includes("WbnmfC"),
    `one warning naming the Klaviyo flow id, got ${JSON.stringify(warnings)}`,
  );

  const noMap: ParseWarning[] = [];
  assert(
    translateFlowProfileFilter(pf, metrics, noMap).length === 1 && noMap.length === 1,
    "no flowIdMap at all behaves the same as an unresolved id",
  );
}

// ─── metric filters mime doesn't translate → warn + drop ────────────────
{
  const warnings: ParseWarning[] = [];
  const pf = {
    condition_groups: [
      { conditions: [zeroTimes("UDH6sQ", last7Days, [
        { property: "$flow", filter: { operator: "not-equals", value: "WvHXtk" } },
      ])] },
      { conditions: [zeroTimes("VCkQXS", flowStart, fromFlow("WvHXtk"))] },
    ],
  };
  const result = translateFlowProfileFilter(pf, metrics, warnings, flowIdMap);
  assert(result.length === 0, `non-equals / non-email $flow filters drop, got ${JSON.stringify(result)}`);
  assert(
    warnings.length === 2 && warnings.every((w) => w.message.includes("$flow equals")),
    `both warn about the supported shape, got ${JSON.stringify(warnings)}`,
  );
}

console.log("flow-profile-filter.smoke.ts: all assertions passed");

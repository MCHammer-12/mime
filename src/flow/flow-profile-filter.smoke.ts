/**
 * Smoke test for the flow-level profile_filter translator.
 *
 *   npx tsx src/flow/flow-profile-filter.smoke.ts
 *
 * Klaviyo flows carry a top-level `definition.profile_filter` that says
 * "only run for profiles matching X". Redo expresses this as a SKIP
 * condition on the trigger step — semantically inverted via De Morgan.
 * These tests pin the inversion logic for the cases that show up in
 * production merchant data:
 *
 *   - Single group, single condition (Charlie 1 Horse UN3tf7)
 *   - Multi-group, single condition each (Charlie 1 Horse WV7RZ5)
 *   - Multi-group with multi-condition groups (warn + first-group-only)
 *   - Unsupported condition types (warn, skip)
 *   - Empty profile_filter (null result)
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
};

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// ─── Empty / absent ──────────────────────────────────────────────────────
{
  const warnings: ParseWarning[] = [];
  assert(
    translateFlowProfileFilter(null, metrics, warnings) === null,
    "null profile_filter → null",
  );
  assert(warnings.length === 0, "null profile_filter pushes no warnings");

  assert(
    translateFlowProfileFilter({ condition_groups: [] }, metrics, warnings) === null,
    "empty condition_groups → null",
  );

  assert(
    translateFlowProfileFilter(
      { condition_groups: [{ conditions: [] }] },
      metrics,
      warnings,
    ) === null,
    "group with 0 conditions → null",
  );
}

// ─── Single group, single condition (UN3tf7 shape) ──────────────────────
{
  const warnings: ParseWarning[] = [];
  const pf = {
    condition_groups: [{
      conditions: [{
        type: "profile-metric",
        metric_id: "VCkQXS",
        measurement: "count",
        measurement_filter: { type: "numeric", operator: "equals", value: 0 },
      }],
    }],
  };
  const result = translateFlowProfileFilter(pf, metrics, warnings) as any;
  assert(result !== null, "single-group single-condition → non-null");
  assert(
    result.dataSource === "inline-segment",
    `dataSource is inline-segment, got ${result.dataSource}`,
  );
  assert(
    result.inlineSegment.mode === "OR",
    `single-group uses OR mode (De Morgan of within-group AND), got ${result.inlineSegment.mode}`,
  );
  assert(
    result.inlineSegment.conditions.length === 1,
    `1 inverted condition, got ${result.inlineSegment.conditions.length}`,
  );
  const c = result.inlineSegment.conditions[0];
  assert(
    c.activityType === "order-placed",
    `activityType resolved via metric lookup, got ${c.activityType}`,
  );
  assert(
    c.count.type === "not_n_times" && c.count.n === 0,
    `count operator inverted (equals 0 → not_n_times 0), got ${JSON.stringify(c.count)}`,
  );
}

// ─── Multi-group, single condition each (WV7RZ5 shape) ──────────────────
{
  const warnings: ParseWarning[] = [];
  const pf = {
    condition_groups: [
      { conditions: [{
        type: "profile-metric", metric_id: "UZjNmf", measurement: "count",
        measurement_filter: { type: "numeric", operator: "equals", value: 0 },
      }] },
      { conditions: [{
        type: "profile-metric", metric_id: "VCkQXS", measurement: "count",
        measurement_filter: { type: "numeric", operator: "equals", value: 0 },
      }] },
    ],
  };
  const result = translateFlowProfileFilter(pf, metrics, warnings) as any;
  assert(result !== null, "multi-group → non-null");
  assert(
    result.inlineSegment.mode === "AND",
    `multi-group uses AND mode (De Morgan of cross-group OR), got ${result.inlineSegment.mode}`,
  );
  assert(
    result.inlineSegment.conditions.length === 2,
    `2 conditions (one per group), got ${result.inlineSegment.conditions.length}`,
  );
  const activities = result.inlineSegment.conditions.map((c: any) => c.activityType).sort();
  assert(
    activities[0] === "checkout-started" && activities[1] === "order-placed",
    `activities are checkout-started + order-placed, got ${JSON.stringify(activities)}`,
  );
}

// ─── Unsupported condition type (profile-not-in-flow) warns + skips ─────
{
  const warnings: ParseWarning[] = [];
  const pf = {
    condition_groups: [
      { conditions: [{ type: "profile-not-in-flow" }] },
    ],
  };
  const result = translateFlowProfileFilter(pf, metrics, warnings);
  assert(
    result === null,
    "unsupported-only profile_filter → null (no Redo conditions to emit)",
  );
  assert(
    warnings.some((w) => w.message.includes("profile-not-in-flow")),
    "warning mentions the unsupported type",
  );
}

// ─── Multi-group with multi-condition group → first-group fallback ──────
{
  const warnings: ParseWarning[] = [];
  const pf = {
    condition_groups: [
      { conditions: [
        { type: "profile-metric", metric_id: "VCkQXS", measurement: "count",
          measurement_filter: { type: "numeric", operator: "equals", value: 0 } },
        { type: "profile-metric", metric_id: "UZjNmf", measurement: "count",
          measurement_filter: { type: "numeric", operator: "greater-than", value: 5 } },
      ] },
      { conditions: [
        { type: "profile-metric", metric_id: "UZjNmf", measurement: "count",
          measurement_filter: { type: "numeric", operator: "equals", value: 0 } },
      ] },
    ],
  };
  const result = translateFlowProfileFilter(pf, metrics, warnings) as any;
  assert(result !== null, "multi-group multi-condition → first-group fallback non-null");
  assert(
    result.inlineSegment.mode === "OR",
    `first-group fallback uses OR mode, got ${result.inlineSegment.mode}`,
  );
  assert(
    result.inlineSegment.conditions.length === 2,
    `2 conditions from the first group, got ${result.inlineSegment.conditions.length}`,
  );
  assert(
    warnings.some((w) => w.message.includes("multiple AND'd conditions")),
    "warning calls out the multi-condition group complexity",
  );
}

// ─── Unknown metric id → warn + skip ────────────────────────────────────
{
  const warnings: ParseWarning[] = [];
  const pf = {
    condition_groups: [{
      conditions: [{
        type: "profile-metric", metric_id: "UNKNOWN", measurement: "count",
        measurement_filter: { type: "numeric", operator: "equals", value: 0 },
      }],
    }],
  };
  const result = translateFlowProfileFilter(pf, metrics, warnings);
  assert(result === null, "unresolvable metric → null");
  assert(
    warnings.some((w) => w.message.includes("UNKNOWN")),
    "warning calls out the unknown metric id",
  );
}

console.log("flow-profile-filter.smoke.ts: all assertions passed");

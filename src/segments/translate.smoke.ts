// Synthetic-definition coverage for the segment translator. No live key needed.
//
//   npx tsx src/segments/translate.smoke.ts
//
// Asserts every Klaviyo condition type, every outcome tier, and — critically —
// the exact Redo zod field names (event / count:{operator,value} /
// timeframe:{type,options} / event_filters), since drift there is a silent 400.

import type { MetricLookup } from "../extract-metrics.js";
import { translateSegment, type TranslateContext } from "./translate.js";
import type { KlaviyoCondition } from "./klaviyo-types.js";

const metrics: MetricLookup = {
  m_order: { id: "m_order", name: "Placed Order", integration_name: null, integration_category: null, integration_key: null, created: null },
  m_open: { id: "m_open", name: "Opened Email", integration_name: null, integration_category: null, integration_key: null, created: null },
};

let passed = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
}

function seg(conditions: KlaviyoCondition[][], extra?: Partial<TranslateContext>, profileCount = 1000) {
  return translateSegment(
    {
      id: "seg1",
      name: "Test",
      profileCount,
      definition: { condition_groups: conditions.map((c) => ({ conditions: c })) },
    },
    { metrics, ...extra },
  );
}

// ── structural: groups → blocks (AND of OR-blocks) ──────────────────────────
{
  const r = seg([
    [{ type: "profile-marketing-consent", consent: { channel: "email", consent_status: { subscription: "subscribed" } } }],
    [{ type: "profile-marketing-consent", consent: { channel: "sms", consent_status: { subscription: "subscribed" } } }],
  ]);
  ok(r.query.conjunction === "AND", "top-level conjunction AND");
  ok(r.query.conditionBlocks.length === 2, "two groups → two blocks");
  ok(r.query.conditionBlocks[0].operator === "OR", "block operator OR");
  ok(r.importable && !r.partial, "fully importable, not partial");
  console.log("✓ structural AND/OR mapping");
}

// ── profile-marketing-consent → boolean ─────────────────────────────────────
{
  const r = seg([[{ type: "profile-marketing-consent", consent: { channel: "email", consent_status: { subscription: "subscribed" } } }]]);
  const c: any = r.query.conditionBlocks[0].conditions[0];
  ok(c.type === "customer_attribute", "consent → customer_attribute");
  ok(c.whereCondition.dimension === "subscribed-to-email", "email consent dimension");
  ok(c.whereCondition.comparison.value === true, "subscribed → true");
  console.log("✓ marketing consent");
}

// ── profile-metric count → exact customer_activity (zod field names) ─────────
{
  const r = seg([[{ type: "profile-metric", metric_id: "m_order", measurement: "count", measurement_filter: { type: "numeric", operator: "greater-than-or-equal", value: 3 }, timeframe_filter: { type: "date", operator: "in-the-last", quantity: 30, unit: "day" } }]]);
  const c: any = r.query.conditionBlocks[0].conditions[0];
  ok(c.type === "customer_activity", "metric → customer_activity");
  ok(c.event === "order-placed", "metric event field = order-placed");
  ok(c.count.operator === "gte" && c.count.value === 3, "count {operator:gte,value:3}");
  ok(c.timeframe.type === "before-now-relative", "timeframe before-now-relative");
  ok(c.timeframe.options.value === 30 && c.timeframe.options.units === "day", "timeframe options 30 day");
  ok(Array.isArray(c.event_filters), "event_filters array present");
  ok(r.substitutions.length === 0, "count metric is exact (no substitution)");
  console.log("✓ profile-metric count");
}

// ── profile-metric value/sum → substituted with order_total event_filter ────
{
  const r = seg([[{ type: "profile-metric", metric_id: "m_order", measurement: "sum_value", measurement_filter: { type: "numeric", operator: "greater-than", value: 250 }, timeframe_filter: { type: "date", operator: "in-the-last", quantity: 90, unit: "day" } }]]);
  const c: any = r.query.conditionBlocks[0].conditions[0];
  ok(c.count.operator === "gt" && c.count.value === 0, "value measure → at-least-once");
  ok(c.event_filters[0].dimension === "order_total", "value filter on order_total");
  ok(c.event_filters[0].comparison.operator === "gt" && c.event_filters[0].comparison.value === 250, "order_total gt 250");
  ok(r.substitutions.length === 1, "value measure is a substitution");
  console.log("✓ profile-metric value");
}

// ── profile-property email ends-with → exact string ─────────────────────────
{
  const r = seg([[{ type: "profile-property", property: "email", filter: { type: "string", operator: "ends-with", value: "@hotmail.com" } }]]);
  const c: any = r.query.conditionBlocks[0].conditions[0];
  ok(c.whereCondition.type === "string" && c.whereCondition.dimension === "email-address", "email → string email-address");
  ok(c.whereCondition.comparison.operator === "ends_with", "ends-with → ends_with");
  console.log("✓ profile-property email ends-with");
}

// ── profile-property email equals → substituted contains ────────────────────
{
  const r = seg([[{ type: "profile-property", property: "email", filter: { operator: "equals", value: "a@b.com" } }]]);
  ok(r.substitutions.length === 1, "email equals is a substitution");
  const c: any = r.query.conditionBlocks[0].conditions[0];
  ok(c.whereCondition.comparison.operator === "contains", "equals degraded to contains");
  console.log("✓ profile-property email equals (degraded)");
}

// ── profile-property $country → exact token (name→ISO) ───────────────────────
{
  const r = seg([[{ type: "profile-property", property: "$country", filter: { operator: "equals", value: "United States" } }]]);
  const c: any = r.query.conditionBlocks[0].conditions[0];
  ok(c.whereCondition.dimension === "country", "country dimension");
  ok(c.whereCondition.comparison.values[0] === "US", "United States → US");
  console.log("✓ profile-property country");
}

// ── profile-property $region → substituted state-province hierarchy ──────────
{
  const r = seg([[{ type: "profile-property", property: "$region", filter: { operator: "equals", value: "TX" } }]]);
  const c: any = r.query.conditionBlocks[0].conditions[0];
  ok(c.whereCondition.type === "token-hierarchy", "state → token-hierarchy");
  ok(c.whereCondition.comparison.prerequisiteValues[0] === "US", "assumes US prerequisite");
  ok(r.substitutions.length === 1, "state assumption is a substitution");
  console.log("✓ profile-property region/state");
}

// ── profile-group-membership: mapped → exact, unmapped → unsupported ─────────
{
  const mapped = seg([[{ type: "profile-group-membership", is_member: true, group_ids: ["L1"] }]], { listToSegment: { L1: "redoSeg1" } });
  const c: any = mapped.query.conditionBlocks[0].conditions[0];
  ok(c.whereCondition.dimension === "static-segment-membership", "membership → static-segment-membership");
  ok(c.whereCondition.comparison.values[0] === "redoSeg1", "maps Klaviyo list → Redo seg id");

  const unmapped = seg([[{ type: "profile-group-membership", is_member: true, group_ids: ["L9"] }]]);
  ok(!unmapped.importable, "unmapped membership-only segment is not importable");
  ok(unmapped.dropped.length === 1, "unmapped membership dropped");
  console.log("✓ profile-group-membership (mapped + unmapped)");
}

// ── predictive: CLV → order-count, AOV → order_total, churn → zero/window ────
{
  const clv = seg([[{ type: "profile-predictive-analytics", dimension: "predicted_clv", filter: { operator: "greater-than-or-equal", value: 500 } }]], { aov: 100 });
  const cc: any = clv.query.conditionBlocks[0].conditions[0];
  ok(cc.event === "order-placed" && cc.count.operator === "gte" && cc.count.value === 5, "CLV 500 / AOV 100 → ≥5 orders");
  ok(clv.substitutions[0].tunable === "order-count", "CLV tunable = order-count");

  const aov = seg([[{ type: "profile-predictive-analytics", dimension: "average_order_value", filter: { operator: "greater-than", value: 80 } }]]);
  const ac: any = aov.query.conditionBlocks[0].conditions[0];
  ok(ac.event_filters[0].dimension === "order_total" && ac.event_filters[0].comparison.value === 80, "AOV → order_total filter");

  const churn = seg([[{ type: "profile-predictive-analytics", dimension: "churn_probability", filter: { operator: "greater-than-or-equal", value: 0.8 } }]]);
  const ch: any = churn.query.conditionBlocks[0].conditions[0];
  ok(ch.count.operator === "eq" && ch.count.value === 0, "churn → zero orders");
  ok(ch.timeframe.type === "before-now-relative", "churn windowed");
  ok(churn.substitutions[0].tunable === "churn-days", "churn tunable = churn-days");
  console.log("✓ predictive analytics substitutions");
}

// ── predictive unsupported: predicted_gender ────────────────────────────────
{
  const r = seg([[{ type: "profile-predictive-analytics", dimension: "predicted_gender", filter: { operator: "equals", value: "female" } }]]);
  ok(!r.importable && r.dropped.length === 1, "predicted_gender dropped, not importable");
  console.log("✓ predicted_gender unsupported");
}

// ── region: US exact, EU substituted ────────────────────────────────────────
{
  const us = seg([[{ type: "profile-region", in_region: true, region_id: "united_states" }]]);
  ok(us.substitutions.length === 0 && us.importable, "US region exact");
  const eu = seg([[{ type: "profile-region", in_region: true, region_id: "european_union" }]]);
  const ec: any = eu.query.conditionBlocks[0].conditions[0];
  ok(ec.whereCondition.comparison.values.length === 27, "EU → 27 country codes");
  ok(eu.substitutions.length === 1, "EU is a substitution");
  console.log("✓ region mapping");
}

// ── postal-code-distance unsupported ────────────────────────────────────────
{
  const r = seg([[{ type: "profile-postal-code-distance", country_code: "USA", postal_code: "02141", unit: "miles", filter: { operator: "less-than", value: 10 } }]]);
  ok(!r.importable && r.dropped.length === 1, "postal distance dropped");
  console.log("✓ postal-code-distance unsupported");
}

// ── partial flag: one good + one dropped condition in same group ─────────────
{
  const r = seg([[
    { type: "profile-marketing-consent", consent: { channel: "email", consent_status: { subscription: "subscribed" } } },
    { type: "profile-predictive-analytics", dimension: "predicted_gender", filter: { operator: "equals", value: "female" } },
  ]]);
  ok(r.importable, "survives with one good condition");
  ok(r.partial, "partial flagged when a sibling condition dropped");
  ok(r.query.conditionBlocks[0].conditions.length === 1, "only the good condition kept");
  console.log("✓ partial-drop handling");
}

console.log(`\n${passed} assertions passed.`);

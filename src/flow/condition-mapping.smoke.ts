/**
 * Smoke test for translateConditionalSplitExpression's
 * profile-marketing-consent path.
 *
 *   npx tsx src/flow/condition-mapping.smoke.ts
 */
import { translateConditionalSplitExpression } from "./condition-mapping.js";
import type { KlaviyoAction, ParseWarning } from "./types.js";

function action(conditions: any[]): KlaviyoAction {
  return {
    id: "test-action",
    type: "conditional-split",
    data: {
      profile_filter: {
        condition_groups: [{ conditions }],
      },
    },
    links: { next: null },
  } as any;
}

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// ─── SMS subscribed → boolean true ────────────────────────────────────────
{
  const warnings: ParseWarning[] = [];
  const out = translateConditionalSplitExpression(
    action([
      {
        type: "profile-marketing-consent",
        consent: {
          channel: "sms",
          can_receive_marketing: true,
          consent_status: { subscription: "subscribed", filters: null },
        },
      },
    ]),
    {},
    warnings,
  ) as any;
  const c = out.inlineSegment.conditions[0];
  if (c?.type !== "customer_attribute") fail("sms subscribed: expected customer_attribute, got " + JSON.stringify(c));
  if (c.whereCondition?.dimension !== "subscribed-to-sms") fail("sms: dimension wrong " + c.whereCondition?.dimension);
  if (c.whereCondition?.comparison?.value !== true) fail("sms subscribed: expected value=true");
  if (warnings.length !== 0) fail(`sms subscribed: unexpected warnings: ${JSON.stringify(warnings)}`);
  console.log("✓ sms subscribed → subscribed-to-sms = true");
}

// ─── Email subscribed → boolean true on email dimension ───────────────────
{
  const warnings: ParseWarning[] = [];
  const out = translateConditionalSplitExpression(
    action([
      {
        type: "profile-marketing-consent",
        consent: {
          channel: "email",
          can_receive_marketing: true,
          consent_status: { subscription: "subscribed", filters: null },
        },
      },
    ]),
    {},
    warnings,
  ) as any;
  const c = out.inlineSegment.conditions[0];
  if (c?.whereCondition?.dimension !== "subscribed-to-email") fail("email: wrong dimension " + c?.whereCondition?.dimension);
  if (c.whereCondition.comparison.value !== true) fail("email subscribed: expected value=true");
  console.log("✓ email subscribed → subscribed-to-email = true");
}

// ─── SMS unsubscribed → boolean false ─────────────────────────────────────
{
  const warnings: ParseWarning[] = [];
  const out = translateConditionalSplitExpression(
    action([
      {
        type: "profile-marketing-consent",
        consent: {
          channel: "sms",
          can_receive_marketing: false,
          consent_status: { subscription: "unsubscribed", filters: null },
        },
      },
    ]),
    {},
    warnings,
  ) as any;
  const c = out.inlineSegment.conditions[0];
  if (c.whereCondition.comparison.value !== false) fail("sms unsubscribed: expected value=false");
  console.log("✓ sms unsubscribed → subscribed-to-sms = false");
}

// ─── Unknown channel → warning, no condition ──────────────────────────────
{
  const warnings: ParseWarning[] = [];
  const out = translateConditionalSplitExpression(
    action([
      {
        type: "profile-marketing-consent",
        consent: {
          channel: "push",
          can_receive_marketing: true,
          consent_status: { subscription: "subscribed", filters: null },
        },
      },
    ]),
    {},
    warnings,
  ) as any;
  if (out.inlineSegment.conditions.length !== 0) fail("unknown channel: expected zero conditions");
  if (warnings.length !== 1) fail(`unknown channel: expected 1 warning, got ${warnings.length}`);
  if (!warnings[0].message.includes('"push"')) fail("unknown channel: warning should name the channel");
  console.log("✓ unknown channel → warning + no condition");
}

console.log("✓ profile-marketing-consent smoke tests pass");

// ─── profile-metric timeframe.quantity (regression for SHOC bug) ─────────
// Klaviyo's in-the-last filter uses `quantity`, not `value`. Before fix,
// every conditional-split timeframe defaulted to 1 day.
{
  const warnings: ParseWarning[] = [];
  const out = translateConditionalSplitExpression(
    action([
      {
        type: "profile-metric",
        metric_id: "m1",
        measurement: "count",
        measurement_filter: { type: "numeric", operator: "greater-than", value: 74 },
        timeframe_filter: { type: "date", operator: "in-the-last", unit: "day", quantity: 30 },
      },
    ]),
    { m1: { id: "m1", name: "Added to Cart", integration_name: null } } as any,
    warnings,
  ) as any;
  const c = out.inlineSegment.conditions[0];
  if (c?.type !== "customer_activity") fail(`quantity: type=${c?.type}`);
  if (c.activityType !== "added-product-to-cart") fail(`quantity: activityType=${c.activityType}`);
  if (c.timeframe?.value !== 30) fail(`quantity: timeframe.value=${c.timeframe?.value} (expected 30)`);
  if (c.timeframe?.units !== "day") fail(`quantity: units=${c.timeframe?.units}`);
  if (c.count?.type !== "greater_than_n" || c.count?.n !== 74) fail(`quantity: count=${JSON.stringify(c.count)}`);
  console.log("✓ profile-metric in-the-last reads tf.quantity (30 days, not 1)");
}

// ─── phone-country-code-in (array value) → country dimension ANY ──────────
{
  const warnings: ParseWarning[] = [];
  const out = translateConditionalSplitExpression(
    action([
      {
        type: "profile-property",
        property: "phone_number",
        filter: { operator: "phone-country-code-in", value: ["US", "CA"] },
      },
    ]),
    {},
    warnings,
  ) as any;
  const c = out.inlineSegment.conditions[0];
  if (c?.type !== "customer_attribute") fail(`phone-cc array: type=${c?.type}`);
  if (c.whereCondition?.type !== "token") fail(`phone-cc array: whereCondition.type=${c.whereCondition?.type}`);
  if (c.whereCondition?.dimension !== "country") fail(`phone-cc array: dimension=${c.whereCondition?.dimension}`);
  if (c.whereCondition?.comparison?.operator !== "ANY") fail(`phone-cc array: operator=${c.whereCondition?.comparison?.operator}`);
  if (JSON.stringify(c.whereCondition?.comparison?.values) !== JSON.stringify(["US", "CA"]))
    fail(`phone-cc array: values=${JSON.stringify(c.whereCondition?.comparison?.values)}`);
  if (!warnings.some((w) => w.kind === "degraded-mapping" && w.message.includes("country")))
    fail("phone-cc array: expected degraded-mapping warning naming country");
  console.log("✓ phone-country-code-in [US,CA] → country dimension ANY");
}

// ─── phone-country-code-in (comma-string value) → same shape ──────────────
{
  const warnings: ParseWarning[] = [];
  const out = translateConditionalSplitExpression(
    action([
      {
        type: "profile-property",
        property: "phone_number",
        filter: { operator: "phone-country-code-in", value: "US,CA" },
      },
    ]),
    {},
    warnings,
  ) as any;
  const c = out.inlineSegment.conditions[0];
  if (JSON.stringify(c?.whereCondition?.comparison?.values) !== JSON.stringify(["US", "CA"]))
    fail(`phone-cc string: values=${JSON.stringify(c?.whereCondition?.comparison?.values)}`);
  console.log("✓ phone-country-code-in 'US,CA' (string) → same as array");
}

// ─── phone-country-code-not-in → operator NONE ────────────────────────────
{
  const warnings: ParseWarning[] = [];
  const out = translateConditionalSplitExpression(
    action([
      {
        type: "profile-property",
        property: "phone_number",
        filter: { operator: "phone-country-code-not-in", value: ["GB"] },
      },
    ]),
    {},
    warnings,
  ) as any;
  const c = out.inlineSegment.conditions[0];
  if (c?.whereCondition?.comparison?.operator !== "NONE") fail(`phone-cc not-in: operator=${c?.whereCondition?.comparison?.operator}`);
  if (JSON.stringify(c.whereCondition.comparison.values) !== JSON.stringify(["GB"]))
    fail(`phone-cc not-in: values=${JSON.stringify(c.whereCondition.comparison.values)}`);
  console.log("✓ phone-country-code-not-in [GB] → country dimension NONE");
}

// ─── lowercase codes normalized to uppercase ISO-2 ────────────────────────
{
  const warnings: ParseWarning[] = [];
  const out = translateConditionalSplitExpression(
    action([
      {
        type: "profile-property",
        property: "phone_number",
        filter: { operator: "phone-country-code-in", value: ["us", " ca ", "xyz", ""] },
      },
    ]),
    {},
    warnings,
  ) as any;
  const c = out.inlineSegment.conditions[0];
  // "us"→US, " ca "→CA (trimmed), "xyz"/"" dropped (not 2-letter)
  if (JSON.stringify(c?.whereCondition?.comparison?.values) !== JSON.stringify(["US", "CA"]))
    fail(`phone-cc normalize: values=${JSON.stringify(c?.whereCondition?.comparison?.values)}`);
  console.log("✓ phone-country-code codes normalized to uppercase ISO-2");
}

// ─── other profile-property → falls back to manual-config placeholder ─────
{
  const warnings: ParseWarning[] = [];
  const out = translateConditionalSplitExpression(
    action([
      {
        type: "profile-property",
        property: "favorite_color",
        filter: { operator: "equals", value: "blue" },
      },
    ]),
    {},
    warnings,
  ) as any;
  if (out.inlineSegment.conditions.length !== 0) fail("other profile-property: expected no condition emitted");
  if (!warnings.some((w) => w.message.includes("manual config required")))
    fail("other profile-property: expected manual-config placeholder warning");
  console.log("✓ non-phone profile-property → manual-config placeholder (unchanged)");
}

console.log("✓ phone-country-code smoke tests pass");

// ─── Value measurement: Added to Cart VALUE > 74.99 → whereCondition ──────
// Regression for the silent count-vs-value bug: the dollar threshold must
// become a numeric whereCondition on cart_subtotal, NOT an event count.
{
  const warnings: ParseWarning[] = [];
  const out = translateConditionalSplitExpression(
    action([
      {
        type: "profile-metric",
        metric_id: "m_atc",
        measurement: "sum_value",
        measurement_filter: { type: "numeric", operator: "greater-than", value: 74.99 },
        timeframe_filter: { type: "date", operator: "in-the-last", unit: "day", quantity: 30 },
      },
    ]),
    { m_atc: { id: "m_atc", name: "Added to Cart", integration_name: null } } as any,
    warnings,
  ) as any;
  const c = out.inlineSegment.conditions[0];
  if (c?.type !== "customer_activity") fail(`value: type=${c?.type}`);
  if (c.activityType !== "added-product-to-cart") fail(`value: activityType=${c.activityType}`);
  if (c.count?.type !== "at_least_once") fail(`value: count=${JSON.stringify(c.count)} (expected at_least_once, NOT a >74 count)`);
  if (c.timeframe?.value !== 30 || c.timeframe?.units !== "day") fail(`value: timeframe=${JSON.stringify(c.timeframe)}`);
  const w = c.whereConditions?.[0];
  if (!w) fail("value: expected a whereCondition, got none");
  if (w.type !== "numeric") fail(`value: whereCondition.type=${w.type}`);
  if (w.dimension !== "cart_subtotal") fail(`value: dimension=${w.dimension}`);
  if (w.comparison?.type !== "numeric" || w.comparison?.operator !== "gt" || w.comparison?.value !== 74.99)
    fail(`value: comparison=${JSON.stringify(w.comparison)} (expected gt 74.99)`);
  if (!warnings.some((x) => x.kind === "degraded-mapping" && x.message.includes("cart_subtotal")))
    fail("value: expected degraded-mapping warning naming cart_subtotal");
  console.log("✓ Added to Cart VALUE > 74.99 → at_least_once + cart_subtotal gt 74.99");
}

// ─── Value measurement on order-placed → order_total ──────────────────────
{
  const warnings: ParseWarning[] = [];
  const out = translateConditionalSplitExpression(
    action([
      {
        type: "profile-metric",
        metric_id: "m_ord",
        measurement: "value",
        measurement_filter: { type: "numeric", operator: "greater-than-or-equal", value: 100 },
        timeframe_filter: { type: "date", operator: "all-time" },
      },
    ]),
    { m_ord: { id: "m_ord", name: "Placed Order", integration_name: null } } as any,
    warnings,
  ) as any;
  const w = out.inlineSegment.conditions[0]?.whereConditions?.[0];
  if (w?.dimension !== "order_total") fail(`order value: dimension=${w?.dimension}`);
  if (w.comparison?.operator !== "gte") fail(`order value: operator=${w.comparison?.operator} (expected gte)`);
  if (w.comparison?.value !== 100) fail(`order value: value=${w.comparison?.value}`);
  console.log("✓ Placed Order VALUE >= 100 → order_total gte 100");
}

// ─── Value measurement on an activity with no monetary dim → warn + skip ──
{
  const warnings: ParseWarning[] = [];
  const out = translateConditionalSplitExpression(
    action([
      {
        type: "profile-metric",
        metric_id: "m_vp",
        measurement: "sum_value",
        measurement_filter: { type: "numeric", operator: "greater-than", value: 5 },
        timeframe_filter: { type: "date", operator: "all-time" },
      },
    ]),
    { m_vp: { id: "m_vp", name: "Viewed Product", integration_name: null } } as any,
    warnings,
  ) as any;
  if (out.inlineSegment.conditions.length !== 0) fail("value no-dim: expected no condition emitted");
  if (!warnings.some((x) => x.message.includes("no Redo value dimension")))
    fail("value no-dim: expected 'no Redo value dimension' warning");
  console.log("✓ value measurement on viewed-product → warn + skip (no monetary dim)");
}

// ─── Count measurement still works (regression) ───────────────────────────
{
  const warnings: ParseWarning[] = [];
  const out = translateConditionalSplitExpression(
    action([
      {
        type: "profile-metric",
        metric_id: "m_atc",
        measurement: "count",
        measurement_filter: { type: "numeric", operator: "greater-than", value: 3 },
        timeframe_filter: { type: "date", operator: "all-time" },
      },
    ]),
    { m_atc: { id: "m_atc", name: "Added to Cart", integration_name: null } } as any,
    warnings,
  ) as any;
  const c = out.inlineSegment.conditions[0];
  if (c?.count?.type !== "greater_than_n" || c.count?.n !== 3) fail(`count regression: count=${JSON.stringify(c?.count)}`);
  if (c.whereConditions?.length !== 0) fail("count regression: whereConditions should be empty");
  if (warnings.length !== 0) fail(`count regression: unexpected warnings ${JSON.stringify(warnings)}`);
  console.log("✓ count measurement → count threshold (unchanged, no warning)");
}

// ─── Absent measurement defaults to count (regression) ────────────────────
{
  const warnings: ParseWarning[] = [];
  const out = translateConditionalSplitExpression(
    action([
      {
        type: "profile-metric",
        metric_id: "m_atc",
        measurement_filter: { type: "numeric", operator: "equals", value: 0 },
        timeframe_filter: { type: "date", operator: "flow-start" },
      },
    ]),
    { m_atc: { id: "m_atc", name: "Added to Cart", integration_name: null } } as any,
    warnings,
  ) as any;
  const c = out.inlineSegment.conditions[0];
  if (c?.count?.type !== "zero_times") fail(`absent-measurement: count=${JSON.stringify(c?.count)}`);
  console.log("✓ absent measurement → count path (zero_times)");
}

// ─── Unknown measurement (e.g. unique) → warn + skip, not count ───────────
{
  const warnings: ParseWarning[] = [];
  const out = translateConditionalSplitExpression(
    action([
      {
        type: "profile-metric",
        metric_id: "m_atc",
        measurement: "unique",
        measurement_filter: { type: "numeric", operator: "greater-than", value: 2 },
        timeframe_filter: { type: "date", operator: "all-time" },
      },
    ]),
    { m_atc: { id: "m_atc", name: "Added to Cart", integration_name: null } } as any,
    warnings,
  ) as any;
  if (out.inlineSegment.conditions.length !== 0) fail("unique: expected no condition emitted");
  if (!warnings.some((x) => x.message.includes('"unique"')))
    fail("unique: expected warning naming the measurement");
  console.log("✓ unknown measurement 'unique' → warn + skip (not silently counted)");
}

console.log("✓ value-measurement smoke tests pass");

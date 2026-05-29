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

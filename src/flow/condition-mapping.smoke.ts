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

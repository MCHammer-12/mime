/**
 * Smoke test: Klaviyo per-message `smart_sending_enabled: false` → Redo
 * flow-wide `trigger.shouldSkipSmartSending: true`.
 *
 *   npx tsx src/flow/smart-sending.smoke.ts
 *
 * Redo honors the per-step field for triggers where the key-default is "don't
 * skip" (abandonment/date/custom — confirmed against redoapp
 * recipient-validation.ts + shouldSkipSmartSendingForTriggerKey). So a Klaviyo
 * flow that disabled smart sending must carry that, or the intent is lost.
 */
import { parseFlow } from "./parser.js";
import { StepType, type KlaviyoFlow } from "./types.js";
import type { MetricLookup } from "../extract-metrics.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

type Sms = { id: string; smart?: boolean | undefined; next: string | null };
function flowWithSms(smsList: Sms[]): KlaviyoFlow {
  const actions = smsList.map((s) => ({
    id: s.id,
    type: "send-sms",
    data: {
      message: {
        body: "Hey {{ first_name }}, your cart misses you!",
        ...(s.smart === undefined ? {} : { smart_sending_enabled: s.smart }),
      },
    },
    links: { next: s.next },
  }));
  return {
    data: {
      id: "flow-ss",
      type: "flow",
      attributes: {
        name: "Smart-sending test",
        status: "draft",
        definition: { triggers: [{ type: "metric", id: "m1", trigger_filter: null }], actions },
      },
    },
  } as unknown as KlaviyoFlow;
}
// "Started Checkout" → CHECKOUT_ABANDONED — a key whose smart-sending default
// is "don't skip", so the per-step field actually matters.
const metrics: MetricLookup = { m1: { id: "m1", name: "Started Checkout", integration_name: null } as any };

function trigger(automation: any): any {
  const t = automation?.steps?.find((s: any) => s.type === StepType.TRIGGER);
  if (!t) fail("no trigger step");
  return t;
}
function mixedWarn(r: any): boolean {
  return (r.warnings ?? []).some((w: any) => /flow-wide/i.test(w.message ?? "") && /smart-sending/i.test(w.message ?? ""));
}

async function main() {
  // 1. One SMS with smart sending OFF → trigger bypasses, no mixed warning.
  {
    const r = await parseFlow(flowWithSms([{ id: "a1", smart: false, next: null }]), metrics, { teamId: "t" });
    if (!r.automation) fail("bypass: no automation");
    if (trigger(r.automation).shouldSkipSmartSending !== true) {
      fail(`bypass: expected shouldSkipSmartSending true, got ${trigger(r.automation).shouldSkipSmartSending}`);
    }
    if (mixedWarn(r)) fail("bypass: unexpected mixed warning for a single-bypass flow");
    console.log("✓ smart_sending_enabled:false → trigger.shouldSkipSmartSending:true (no mixed warning)");
  }

  // 2. SMS with smart sending ON (and one omitted = default on) → field omitted.
  {
    const r = await parseFlow(
      flowWithSms([{ id: "a1", smart: true, next: "a2" }, { id: "a2", smart: undefined, next: null }]),
      metrics,
      { teamId: "t" },
    );
    if (!r.automation) fail("default: no automation");
    if (trigger(r.automation).shouldSkipSmartSending !== undefined) {
      fail(`default: expected shouldSkipSmartSending omitted, got ${trigger(r.automation).shouldSkipSmartSending}`);
    }
    if (mixedWarn(r)) fail("default: unexpected mixed warning");
    console.log("✓ all smart-sending on/default → field omitted (Redo default throttle stands)");
  }

  // 3. Mixed (one off, one on) → bypass true + a mixed-intent warning.
  {
    const r = await parseFlow(
      flowWithSms([{ id: "a1", smart: false, next: "a2" }, { id: "a2", smart: true, next: null }]),
      metrics,
      { teamId: "t" },
    );
    if (!r.automation) fail("mixed: no automation");
    if (trigger(r.automation).shouldSkipSmartSending !== true) fail("mixed: expected bypass true");
    if (!mixedWarn(r)) fail("mixed: expected a flow-wide smart-sending warning");
    console.log("✓ mixed on/off → bypass true + flow-wide review warning");
  }

  console.log("\nAll smart-sending smoke checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

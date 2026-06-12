/**
 * Smoke test for flow-level `definition.reentry_criteria` translation.
 *
 *   npx tsx src/flow/flow-reentry-criteria.smoke.ts
 *
 * Klaviyo's reentry_criteria says "wait N days before letting the same
 * profile re-enter THIS flow". Redo has no native field for this, so the
 * parser approximates it as a received-email skip condition in the
 * window. These tests lock in the approximation shape + warning text and
 * verify the absent-field case is a clean no-op.
 */
import { parseFlow } from "./parser.js";
import { MARKETING_TRIGGER_OPTIONS } from "./marketing-trigger-options.js";
import type { KlaviyoFlow } from "./types.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

function buildFlow(opts: {
  reentry?: { duration: number; unit: string } | null;
  triggerFilter?: unknown;
}): KlaviyoFlow {
  return {
    data: {
      id: "flow-test",
      attributes: {
        name: "reentry test flow",
        status: "draft",
        trigger_type: "Metric",
        definition: {
          triggers: [{
            type: "metric",
            id: "metric-X",
            ...(opts.triggerFilter !== undefined ? { trigger_filter: opts.triggerFilter } : {}),
          }],
          actions: [],
          ...(opts.reentry !== undefined ? { reentry_criteria: opts.reentry as any } : {}),
        } as any,
      },
    },
  } as unknown as KlaviyoFlow;
}

const cart = MARKETING_TRIGGER_OPTIONS.find((o) => o.value === "cart_abandonment");
if (!cart) throw new Error("cart_abandonment trigger option missing");

async function main() {
  // ─── reentry_criteria present (30 days, BA-style) ─────────────────────
  {
    const flow = buildFlow({ reentry: { duration: 30, unit: "day" } });
    const r = await parseFlow(flow, {}, { teamId: "t", forcedTrigger: cart.resolution });
    const trig = r.automation?.steps.find((s) => s.type === "trigger") as any;
    const skipConditions = trig?.skipConditions?.conditions ?? [];
    const reentrySkip = skipConditions.find(
      (c: any) =>
        c.dataSource === "inline-segment" &&
        c.inlineSegment?.conditions?.[0]?.activityType === "received-email",
    );
    assert(!!reentrySkip, "30-day reentry → received-email skip condition emitted");
    const inner = reentrySkip.inlineSegment.conditions[0];
    assert(
      inner.count.type === "at_least_once",
      `count is at_least_once, got ${JSON.stringify(inner.count)}`,
    );
    assert(
      inner.timeframe.type === "before-now-relative" &&
        inner.timeframe.value === 30 &&
        inner.timeframe.units === "day",
      `timeframe is 30 days before now, got ${JSON.stringify(inner.timeframe)}`,
    );
    const w = r.warnings.find((x) => x.message.includes("reentry_criteria"));
    assert(!!w, "warning emitted explaining the approximation");
    assert(
      !!w && w.message.includes("30 days") && w.message.includes("broader"),
      `warning calls out duration + broader scope, got: ${w?.message}`,
    );
  }

  // ─── reentry_criteria absent → no received-email skip, no warning ─────
  {
    const flow = buildFlow({});
    const r = await parseFlow(flow, {}, { teamId: "t", forcedTrigger: cart.resolution });
    const trig = r.automation?.steps.find((s) => s.type === "trigger") as any;
    const skipConditions = trig?.skipConditions?.conditions ?? [];
    const reentrySkip = skipConditions.find(
      (c: any) =>
        c.dataSource === "inline-segment" &&
        c.inlineSegment?.conditions?.[0]?.activityType === "received-email",
    );
    assert(!reentrySkip, "no reentry_criteria → no received-email skip");
    const w = r.warnings.find((x) => x.message.includes("reentry_criteria"));
    assert(!w, "no warning when reentry_criteria absent");
  }

  // ─── reentry_criteria with zero / invalid duration → no skip ─────────
  for (const bad of [{ duration: 0, unit: "day" }, { duration: -5, unit: "day" }]) {
    const flow = buildFlow({ reentry: bad });
    const r = await parseFlow(flow, {}, { teamId: "t", forcedTrigger: cart.resolution });
    const trig = r.automation?.steps.find((s) => s.type === "trigger") as any;
    const skipConditions = trig?.skipConditions?.conditions ?? [];
    const reentrySkip = skipConditions.find(
      (c: any) =>
        c.dataSource === "inline-segment" &&
        c.inlineSegment?.conditions?.[0]?.activityType === "received-email",
    );
    assert(!reentrySkip, `duration=${bad.duration} → no skip emitted`);
  }

  // ─── singular unit grammar (1 hour, not 1 hours) ──────────────────────
  {
    const flow = buildFlow({ reentry: { duration: 1, unit: "hour" } });
    const r = await parseFlow(flow, {}, { teamId: "t", forcedTrigger: cart.resolution });
    const w = r.warnings.find((x) => x.message.includes("reentry_criteria"));
    assert(
      !!w && w.message.includes("1 hour") && !w.message.includes("1 hours"),
      `singular unit "1 hour", got: ${w?.message}`,
    );
  }

  // ─── trigger_filter present → review warning ──────────────────────────
  {
    const flow = buildFlow({ triggerFilter: { condition_groups: [{ conditions: [] }] } });
    const r = await parseFlow(flow, {}, { teamId: "t", forcedTrigger: cart.resolution });
    const w = r.warnings.find((x) => x.message.includes("trigger_filter"));
    assert(!!w, "trigger_filter present → warning surfaces it");
  }

  // ─── trigger_filter absent (Charlie's case) → no warning ──────────────
  {
    const flow = buildFlow({});
    const r = await parseFlow(flow, {}, { teamId: "t", forcedTrigger: cart.resolution });
    const w = r.warnings.find((x) => x.message.includes("trigger_filter"));
    assert(!w, "trigger_filter absent → no warning");
  }

  console.log("flow-reentry-criteria.smoke.ts: all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * Smoke test for Viewed Product / Active on Site → Browse Abandonment with
 * mutually-exclusive viewed-product skip conditions. The two Klaviyo triggers
 * collapse to one Redo trigger (MARKETING_BROWSE_ABANDONMENT); parseFlow has
 * to layer a customer_activity[viewed-product] skip on top of the existing
 * isBrowseAbandoned skip so they don't double-fire on the same customer.
 *
 *   npx tsx src/flow/browse-trigger-mapping.smoke.ts
 */
import { parseFlow } from "./parser.js";
import { SchemaType, type KlaviyoFlow, type KlaviyoAction } from "./types.js";
import type { MetricLookup } from "../extract-metrics.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function flowWith(metricName: string, delayHours: number | null): KlaviyoFlow {
  const actions: KlaviyoAction[] = [];
  if (delayHours !== null) {
    actions.push({
      id: "wait-1",
      type: "time-delay",
      data: { unit: "hours", value: delayHours },
      links: { next: null },
    } as any);
  }
  return {
    data: {
      id: "flow-x",
      type: "flow",
      attributes: {
        name: `Smoke ${metricName}`,
        status: "draft",
        definition: {
          triggers: [{ type: "metric", id: "m1", trigger_filter: null }],
          actions,
        },
      },
    },
  } as any;
}

function metricsFor(name: string): MetricLookup {
  return { m1: { id: "m1", name, integration_name: null } as any };
}

function getSkipConditions(automation: any): any[] {
  const trig = automation?.steps?.find((s: any) => s.type === "trigger");
  if (!trig) fail("no TRIGGER step in automation");
  return trig.skipConditions?.conditions ?? [];
}

async function main() {
  // ─── Viewed Product flow, 2-hour delay ─────────────────────────────────
  {
    const res = await parseFlow(flowWith("Viewed Product", 2), metricsFor("Viewed Product"), {
      teamId: "team-x",
    });
    if (!res.automation) fail("Viewed Product: no automation");
    if (res.automation.schemaType !== SchemaType.MARKETING_BROWSE_ABANDONMENT) {
      fail(`Viewed Product: schemaType=${res.automation.schemaType}`);
    }
    const skips = getSkipConditions(res.automation);
    if (skips.length !== 2) fail(`Viewed Product: expected 2 skip conditions, got ${skips.length}: ${JSON.stringify(skips)}`);

    const trigData = skips.find((s) => s.dataSource === "trigger-data");
    if (trigData?.schemaBooleanExpression?.field !== "isBrowseAbandoned") {
      fail(`Viewed Product: trigger-data skip field=${trigData?.schemaBooleanExpression?.field}`);
    }

    const seg = skips.find((s) => s.dataSource === "inline-segment");
    const cond = seg?.inlineSegment?.conditions?.[0];
    if (cond?.activityType !== "viewed-product") fail(`Viewed Product: activityType=${cond?.activityType}`);
    if (cond?.count?.type !== "zero_times") fail(`Viewed Product: count.type=${cond?.count?.type} (expected zero_times)`);
    if (cond?.timeframe?.value !== 2) fail(`Viewed Product: timeframe.value=${cond?.timeframe?.value}`);
    if (cond?.timeframe?.units !== "hour") fail(`Viewed Product: timeframe.units=${cond?.timeframe?.units}`);
    console.log("✓ Viewed Product + 2h delay → zero_times skip in last 2 hours");
  }

  // ─── Active on Site flow, 30-minute delay ──────────────────────────────
  {
    const res = await parseFlow(
      // 30 minutes → unit "minutes", value 30
      {
        data: {
          id: "flow-x",
          type: "flow",
          attributes: {
            name: "Smoke Active",
            status: "draft",
            definition: {
              triggers: [{ type: "metric", id: "m1", trigger_filter: null }],
              actions: [
                {
                  id: "wait-1",
                  type: "time-delay",
                  data: { unit: "minutes", value: 30 },
                  links: { next: null },
                },
              ],
            },
          },
        },
      } as any,
      metricsFor("Active on Site"),
      { teamId: "team-x" },
    );
    if (!res.automation) fail("Active on Site: no automation");
    const skips = getSkipConditions(res.automation);
    const seg = skips.find((s) => s.dataSource === "inline-segment");
    const cond = seg?.inlineSegment?.conditions?.[0];
    if (cond?.count?.type !== "at_least_once") fail(`Active on Site: count.type=${cond?.count?.type} (expected at_least_once)`);
    if (cond?.timeframe?.units !== "minute") fail(`Active on Site: units=${cond?.timeframe?.units}`);
    if (cond?.timeframe?.value !== 30) fail(`Active on Site: value=${cond?.timeframe?.value}`);
    console.log("✓ Active on Site + 30m delay → at_least_once skip in last 30 minutes");
  }

  // ─── No time-delay action → default to 24h + warning ───────────────────
  {
    const res = await parseFlow(flowWith("Viewed Product", null), metricsFor("Viewed Product"), {
      teamId: "team-x",
    });
    if (!res.automation) fail("no-delay: no automation");
    const skips = getSkipConditions(res.automation);
    const seg = skips.find((s) => s.dataSource === "inline-segment");
    const cond = seg?.inlineSegment?.conditions?.[0];
    if (cond?.timeframe?.value !== 24) fail(`no-delay: value=${cond?.timeframe?.value} (expected 24)`);
    if (cond?.timeframe?.units !== "hour") fail(`no-delay: units=${cond?.timeframe?.units} (expected hour)`);
    const warn = res.warnings.find((w) => /defaulting viewed-product skip/.test(w.message));
    if (!warn) fail(`no-delay: expected default-window warning, got: ${JSON.stringify(res.warnings)}`);
    console.log("✓ no time-delay action → defaults to 24h + warns");
  }

  // ─── Non-browse trigger (Started Checkout → Checkout Abandonment) ──────
  // Started Checkout maps to CHECKOUT abandonment (reversed PR #43, 2026-06-12).
  // Asserts: no viewed-product inline-segment skip, and the auto skip field is
  // isCheckoutAbandoned (not isCartAbandoned).
  {
    const res = await parseFlow(flowWith("Started Checkout", 1), metricsFor("Started Checkout"), {
      teamId: "team-x",
    });
    if (!res.automation) fail("checkout: no automation");
    const skips = getSkipConditions(res.automation);
    if (skips.length !== 1) fail(`checkout: expected exactly 1 skip (isCheckoutAbandoned), got ${skips.length}`);
    const seg = skips.find((s) => s.dataSource === "inline-segment");
    if (seg) fail(`checkout: unexpected inline-segment skip on non-browse trigger`);
    const field = skips[0]?.schemaBooleanExpression?.field;
    if (field !== "isCheckoutAbandoned") fail(`checkout: expected skip field isCheckoutAbandoned, got ${field}`);
    console.log("✓ Started Checkout → Checkout Abandonment (isCheckoutAbandoned skip, no viewed-product skip)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

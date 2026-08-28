/**
 * Smoke test for flow-level `definition.reentry_criteria` translation.
 *
 *   npx tsx src/flow/flow-reentry-criteria.smoke.ts
 *
 * Klaviyo's reentry_criteria says "wait N days before letting the same
 * profile re-enter THIS flow". Redo's native equivalent is `frequencyCap`
 * on the trigger step, so this translates exactly (no approximation, no
 * review warning). Klaviyo surfaces the same setting a second way — a
 * `profile-not-in-flow` condition in `profile_filter` — which must also
 * land on frequencyCap and must NOT produce a manual-review warning.
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
  notInFlow?: boolean;
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
          ...(opts.notInFlow
            ? {
                profile_filter: {
                  condition_groups: [{ conditions: [{ type: "profile-not-in-flow" }] }],
                },
              }
            : {}),
        } as any,
      },
    },
  } as unknown as KlaviyoFlow;
}

const cart = MARKETING_TRIGGER_OPTIONS.find((o) => o.value === "cart_abandonment");
if (!cart) throw new Error("cart_abandonment trigger option missing");

const trigger = (r: any) => r.automation?.steps.find((s: any) => s.type === "trigger") as any;

async function main() {
  // ─── reentry_criteria present (30 days, BA-style) → COOLDOWN ──────────
  {
    const flow = buildFlow({ reentry: { duration: 30, unit: "day" } });
    const r = await parseFlow(flow, {}, { teamId: "t", forcedTrigger: cart.resolution });
    const trig = trigger(r);
    assert(
      JSON.stringify(trig?.frequencyCap) ===
        JSON.stringify({ mode: "COOLDOWN", value: 30, unit: "Days" }),
      `30-day reentry → COOLDOWN 30 Days, got ${JSON.stringify(trig?.frequencyCap)}`,
    );
    // The old approximation must be gone — no received-email skip, no warning.
    const skipConditions = trig?.skipConditions?.conditions ?? [];
    assert(
      !skipConditions.some(
        (c: any) => c.inlineSegment?.conditions?.[0]?.activityType === "received-email",
      ),
      "reentry no longer emits a received-email skip approximation",
    );
    assert(
      !r.warnings.some((x) => x.message.includes("reentry_criteria")),
      "native frequencyCap → no manual-review warning",
    );
  }

  // ─── unit "alltime" → NO_REENTRY ──────────────────────────────────────
  {
    const flow = buildFlow({ reentry: { duration: 1, unit: "alltime" } });
    const r = await parseFlow(flow, {}, { teamId: "t", forcedTrigger: cart.resolution });
    assert(
      JSON.stringify(trigger(r)?.frequencyCap) === JSON.stringify({ mode: "NO_REENTRY" }),
      `alltime reentry → NO_REENTRY, got ${JSON.stringify(trigger(r)?.frequencyCap)}`,
    );
  }

  // ─── hour / minute units carry through ────────────────────────────────
  for (const [unit, expected] of [["hour", "Hours"], ["minute", "Minutes"]] as const) {
    const flow = buildFlow({ reentry: { duration: 6, unit } });
    const r = await parseFlow(flow, {}, { teamId: "t", forcedTrigger: cart.resolution });
    assert(
      trigger(r)?.frequencyCap?.unit === expected,
      `unit "${unit}" → ${expected}, got ${JSON.stringify(trigger(r)?.frequencyCap)}`,
    );
  }

  // ─── profile-not-in-flow alone → NO_REENTRY, silently ─────────────────
  {
    const flow = buildFlow({ notInFlow: true });
    const r = await parseFlow(flow, {}, { teamId: "t", forcedTrigger: cart.resolution });
    assert(
      JSON.stringify(trigger(r)?.frequencyCap) === JSON.stringify({ mode: "NO_REENTRY" }),
      `profile-not-in-flow → NO_REENTRY, got ${JSON.stringify(trigger(r)?.frequencyCap)}`,
    );
    assert(
      !r.warnings.some((x) => x.message.includes("profile-not-in-flow")),
      "profile-not-in-flow is handled natively, so it must not warn",
    );
  }

  // ─── reentry_criteria wins over profile-not-in-flow (they agree) ──────
  {
    const flow = buildFlow({ reentry: { duration: 7, unit: "day" }, notInFlow: true });
    const r = await parseFlow(flow, {}, { teamId: "t", forcedTrigger: cart.resolution });
    assert(
      JSON.stringify(trigger(r)?.frequencyCap) ===
        JSON.stringify({ mode: "COOLDOWN", value: 7, unit: "Days" }),
      `both present → the explicit interval wins, got ${JSON.stringify(trigger(r)?.frequencyCap)}`,
    );
  }

  // ─── reentry_criteria absent → no frequencyCap at all ─────────────────
  {
    const flow = buildFlow({});
    const r = await parseFlow(flow, {}, { teamId: "t", forcedTrigger: cart.resolution });
    assert(trigger(r)?.frequencyCap === undefined, "no reentry_criteria → field omitted");
    assert(
      !r.warnings.some((x) => x.message.includes("reentry_criteria")),
      "no warning when reentry_criteria absent",
    );
  }

  // ─── zero / negative duration → no frequencyCap ───────────────────────
  for (const bad of [{ duration: 0, unit: "day" }, { duration: -5, unit: "day" }]) {
    const flow = buildFlow({ reentry: bad });
    const r = await parseFlow(flow, {}, { teamId: "t", forcedTrigger: cart.resolution });
    assert(
      trigger(r)?.frequencyCap === undefined,
      `duration=${bad.duration} → no frequencyCap emitted`,
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

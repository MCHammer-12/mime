/**
 * Smoke test for per-message `additional_filters` on a Klaviyo send-email.
 * Klaviyo gates the single message; Redo has no per-step filter, so the
 * parser splices CONDITION → send with the false branch jumping past it.
 * Cases come from Relay Goods Y34myV (Welcome Series_15 Off), whose two
 * sends both carry `profile-group-membership` — the shape that used to
 * vanish with no warning at all.
 *
 *   npx tsx src/flow/message-additional-filters.smoke.ts
 */
import { translateMessageAdditionalFilters } from "./condition-mapping.js";
import { parseFlow } from "./parser.js";
import type { MetricLookup } from "../extract-metrics.js";
import type { KlaviyoFlow, ParseWarning } from "./types.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const metrics: MetricLookup = {
  XDMQiD: { id: "XDMQiD", name: "Placed Order" } as MetricLookup[string],
};

const groupMembership = {
  condition_groups: [
    { conditions: [{ type: "profile-group-membership", group_ids: ["S9CFfQ"], is_member: false }] },
  ],
};
const placedOrderZero = {
  condition_groups: [
    {
      conditions: [
        {
          type: "profile-metric",
          metric_id: "XDMQiD",
          measurement: "count",
          timeframe_filter: { type: "date", operator: "alltime" },
          measurement_filter: { type: "numeric", value: 0, operator: "equals" },
        },
      ],
    },
  ],
};

// ─── Untranslatable filter → null + a warning naming the consequence ─────
{
  const warnings: ParseWarning[] = [];
  const out = translateMessageAdditionalFilters(groupMembership, metrics, warnings, "A1");
  assert(out === null, "untranslatable additional_filters yields no gate");
  assert(
    warnings.some((w) => /this message will go to everyone/i.test(w.message)),
    "untranslatable filter warns that the message is now unfiltered",
  );
  assert(
    warnings.some((w) => /profile-group-membership/.test(w.message)),
    "the per-condition reason is still surfaced",
  );
}

// ─── No additional_filters → null, and no noise ──────────────────────────
{
  const warnings: ParseWarning[] = [];
  assert(
    translateMessageAdditionalFilters(null, metrics, warnings, "A1") === null &&
      translateMessageAdditionalFilters({ condition_groups: [] }, metrics, warnings, "A1") === null,
    "absent additional_filters yields no gate",
  );
  assert(warnings.length === 0, "absent additional_filters warns about nothing");
}

// ─── Translatable filter → an inline-segment expression ──────────────────
{
  const warnings: ParseWarning[] = [];
  const out: any = translateMessageAdditionalFilters(placedOrderZero, metrics, warnings, "A1");
  assert(out?.dataSource === "inline-segment", "translated gate is an inline segment");
  assert(out.inlineSegment.conditions.length === 1, "the one condition made it across");
}

// ─── End to end: the gate takes the action id, the send moves aside ──────
function flowWith(additionalFilters: unknown): KlaviyoFlow {
  return {
    data: {
      id: "TEST01",
      attributes: {
        name: "Welcome Series",
        status: "live",
        definition: {
          entry_action_id: "A1",
          triggers: [{ id: "L1", type: "list" }],
          profile_filter: null,
          actions: [
            {
              id: "A1",
              type: "send-email",
              links: { next: "A2" },
              data: {
                status: "live",
                message: {
                  template_id: "T1",
                  subject_line: "Welcome",
                  additional_filters: additionalFilters,
                },
              },
            },
            {
              id: "A2",
              type: "send-email",
              links: { next: null },
              data: { status: "live", message: { template_id: "T2", subject_line: "Second" } },
            },
          ],
        },
      },
    },
  } as unknown as KlaviyoFlow;
}

{
  const parsed = await parseFlow(flowWith(placedOrderZero), metrics, { teamId: "T" });
  const steps: any[] = parsed.automation!.steps;
  const byId = new Map(steps.map((s) => [s.id, s]));
  const gate = byId.get("A1");
  assert(gate?.type === "condition", "the gate takes the Klaviyo action id");

  const send = byId.get(gate.nextTrueId);
  assert(
    send?.type === "send_email" && send.templateId === "__PLACEHOLDER_T1__",
    "true branch sends the gated message",
  );

  // False branch skips the gated send and lands on the next action. treeify
  // clones the shared tail (two parents now reach it), so compare the step,
  // not the id.
  const skipped = byId.get(gate.nextFalseId);
  assert(
    skipped?.type === "send_email" && skipped.templateId === "__PLACEHOLDER_T2__",
    "false branch skips the gated send and continues the flow",
  );
  assert(
    byId.get(send.nextId)?.templateId === "__PLACEHOLDER_T2__",
    "the gated send still continues to the next action",
  );

  const trigger = steps.find((s) => s.type === "trigger");
  assert(trigger.nextId === "A1", "the trigger enters through the gate");

  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    for (const k of ["nextId", "nextTrueId", "nextFalseId"]) {
      assert(!s[k] || ids.has(s[k]), `no dangling ${s.id}.${k} -> ${s[k]}`);
    }
  }
}

// ─── An untranslatable filter leaves the graph exactly as it was ─────────
{
  const parsed = await parseFlow(flowWith(groupMembership), metrics, { teamId: "T" });
  const steps: any[] = parsed.automation!.steps;
  assert(
    steps.find((s) => s.id === "A1")?.type === "send_email",
    "no gate is spliced when nothing translated",
  );
  assert(!steps.some((s) => s.id === "A1__msg"), "the send keeps its own id");
}

console.log("message-additional-filters smoke: OK");

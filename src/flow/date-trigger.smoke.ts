/**
 * Smoke test: Klaviyo `date` trigger → Redo marketing_date trigger with valid
 * `triggerSpecificFields`. Without these, createAdvancedFlow 400s on a 50KB Zod
 * wall and the whole flow (including its email content) fails to import.
 *
 *   npx tsx src/flow/date-trigger.smoke.ts
 *
 * Redo's date trigger supports only a birthday dimension; mime defaults to
 * "birthday, on the day" + a degraded-mapping warning. Shape confirmed against
 * redoapp marketingDateTriggerStepSchema (dimension + comparison union).
 */
import { parseFlow } from "./parser.js";
import { resolveTrigger } from "./trigger-mapping.js";
import { StepType, SchemaType, type KlaviyoFlow } from "./types.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function dateFlow(): KlaviyoFlow {
  return {
    data: {
      id: "flow-bday",
      type: "flow",
      attributes: {
        name: "Happy Birthday",
        status: "draft",
        definition: {
          triggers: [{ type: "date" }],
          actions: [
            {
              id: "a1",
              type: "send-sms",
              data: { message: { body: "Happy birthday {{ first_name }}! 🎉" } },
              links: { next: null },
            },
          ],
        },
      },
    },
  } as unknown as KlaviyoFlow;
}

const EXPECTED = { dimension: "birthday", comparison: { type: "today", options: null } };

async function main() {
  // resolveTrigger: date → MARKETING_DATE + triggerSpecificFields + warning.
  {
    const warnings: any[] = [];
    const r = resolveTrigger(dateFlow(), {}, warnings);
    if (!r) fail("resolveTrigger returned null for a date trigger");
    if (r.schemaType !== SchemaType.MARKETING_DATE) fail(`expected marketing_date, got ${r.schemaType}`);
    if (JSON.stringify(r.triggerSpecificFields) !== JSON.stringify(EXPECTED)) {
      fail(`triggerSpecificFields wrong: ${JSON.stringify(r.triggerSpecificFields)}`);
    }
    if (!warnings.some((w) => w.kind === "degraded-mapping" && /date trigger/i.test(w.message ?? ""))) {
      fail("expected a degraded-mapping warning for the date trigger");
    }
    console.log("✓ resolveTrigger: date → marketing_date + {dimension:birthday, comparison:today} + warning");
  }

  // parseFlow end-to-end: the trigger STEP carries triggerSpecificFields.
  {
    const r = await parseFlow(dateFlow(), {}, { teamId: "t" });
    if (!r.automation) fail("parseFlow: no automation for date-trigger flow");
    const trig: any = r.automation.steps.find((s: any) => s.type === StepType.TRIGGER);
    if (!trig) fail("no trigger step");
    if (trig.schemaType !== SchemaType.MARKETING_DATE) fail(`trigger schemaType ${trig.schemaType}`);
    if (JSON.stringify(trig.triggerSpecificFields) !== JSON.stringify(EXPECTED)) {
      fail(`trigger step triggerSpecificFields wrong: ${JSON.stringify(trig.triggerSpecificFields)}`);
    }
    console.log("✓ parseFlow: marketing_date trigger STEP carries valid triggerSpecificFields");
  }

  // A non-date trigger must NOT get triggerSpecificFields (regression).
  {
    const r = await parseFlow(
      {
        data: { id: "f", type: "flow", attributes: { name: "n", status: "draft",
          definition: { triggers: [{ type: "metric", id: "m1" }], actions: [{ id: "a1", type: "send-sms", data: { message: { body: "hi" } }, links: { next: null } }] } } },
      } as unknown as KlaviyoFlow,
      { m1: { id: "m1", name: "Started Checkout", integration_name: null } as any },
      { teamId: "t" },
    );
    const trig: any = r.automation?.steps.find((s: any) => s.type === StepType.TRIGGER);
    if (trig?.triggerSpecificFields !== undefined) fail("non-date trigger should not carry triggerSpecificFields");
    console.log("✓ non-date trigger (Started Checkout) → no triggerSpecificFields");
  }

  console.log("\nAll date-trigger smoke checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

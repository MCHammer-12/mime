/**
 * Smoke test: Klaviyo custom metric → Redo `custom_event` trigger.
 *
 *   npx tsx src/flow/custom-event-trigger.smoke.ts
 *
 * Redo's custom-event trigger fires on an exact `eventName` match against
 * events delivered to its public custom-event API. Contract confirmed against
 * redoapp customEventTriggerStepSchema (category "Custom Event", key
 * "custom_event", top-level eventName, optional triggerSpecificFields.conditions).
 *
 * Three guarantees:
 *  1. Never auto-resolved. An unmapped Klaviyo metric still returns null →
 *     trigger picker (Michael 2026-06-12). Guessing a Redo event name yields a
 *     flow that looks configured and silently never fires, which is worse than
 *     asking.
 *  2. When the operator DOES pick it, the trigger step carries eventName taken
 *     from the Klaviyo metric name — the only identity the event has here.
 *  3. Send-email steps reference customerFirstName, not customerFullName.
 *     customEventSchema has no combined name field, and Redo's
 *     validateStepFieldReferences rejects the whole createAdvancedFlow when a
 *     *FieldName names a field the schema lacks.
 */
import { findOptionByValue } from "./marketing-trigger-options.js";
import { parseFlow, recipientNameFieldForSchema } from "./parser.js";
import { customEventResolution, resolveTrigger } from "./trigger-mapping.js";
import { SchemaType, StepType, type KlaviyoFlow } from "./types.js";
import type { MetricLookup } from "../extract-metrics.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const OKENDO_METRIC = "Submitted Okendo Survey";

function metricFlow(): KlaviyoFlow {
  return {
    data: {
      id: "S6ghDv",
      type: "flow",
      attributes: {
        name: "Okendo Survey Follow-up",
        status: "draft",
        definition: {
          triggers: [{ type: "metric", id: "m1" }],
          actions: [
            {
              id: "a1",
              type: "send-email",
              data: { message: { subject_line: "Thanks!" } },
              links: { next: null },
            },
          ],
        },
      },
    },
  } as unknown as KlaviyoFlow;
}

const metrics: MetricLookup = {
  m1: { id: "m1", name: OKENDO_METRIC, integration_name: "Okendo" } as any,
};

async function main() {
  // ── The policy: an unmapped metric is never silently a custom event ────────
  {
    const warnings: any[] = [];
    const r = resolveTrigger(metricFlow(), metrics, warnings);
    if (r !== null) {
      fail(`"${OKENDO_METRIC}" auto-resolved to ${JSON.stringify(r)} — expected null (skip→picker)`);
    }
    if (!warnings.some((w) => /Custom event/i.test(w.message ?? ""))) {
      fail("unsupported-trigger warning should point at the Custom event picker option");
    }
    console.log("✓ unmapped metric → null (picker), warning names the Custom event option");
  }

  // ── The picker option exists and carries no baked-in event name ────────────
  {
    const opt = findOptionByValue("custom_event");
    if (!opt) fail("no custom_event option in MARKETING_TRIGGER_OPTIONS");
    const res = opt.resolution;
    if (res.schemaType !== SchemaType.CUSTOM_EVENT) fail(`schemaType ${res.schemaType}`);
    if (res.category !== "Custom Event") fail(`category ${res.category}`);
    if (res.key !== "custom_event") fail(`key ${res.key}`);
    if (res.eventName !== undefined) fail("picker option must not bake in an eventName");
    console.log("✓ picker option: custom_event / Custom Event / custom_event, eventName unset");
  }

  // ── Picked → trigger step carries the Klaviyo metric name ─────────────────
  {
    const r = await parseFlow(metricFlow(), metrics, {
      teamId: "t",
      forcedTrigger: customEventResolution(),
    });
    if (!r.automation) fail("parseFlow returned no automation for the picked custom_event trigger");
    const trig: any = r.automation.steps.find((s: any) => s.type === StepType.TRIGGER);
    if (!trig) fail("no trigger step");
    if (trig.schemaType !== SchemaType.CUSTOM_EVENT) fail(`trigger schemaType ${trig.schemaType}`);
    if (trig.category !== "Custom Event") fail(`trigger category ${trig.category}`);
    if (trig.key !== "custom_event") fail(`trigger key ${trig.key}`);
    if (trig.eventName !== OKENDO_METRIC) fail(`eventName ${JSON.stringify(trig.eventName)}`);
    if (r.automation.schemaType !== SchemaType.CUSTOM_EVENT) {
      fail(`automation schemaType ${r.automation.schemaType}`);
    }
    if (!r.warnings.some((w) => /custom-event trigger set to eventName/.test(w.message))) {
      fail("expected a requires-review warning naming the eventName + ingestion caveat");
    }
    console.log(`✓ parseFlow: trigger step eventName = "${OKENDO_METRIC}" + ingestion warning`);

    // ── The field-reference gate ────────────────────────────────────────────
    const email: any = r.automation.steps.find((s: any) => s.type === StepType.SEND_EMAIL);
    if (!email) fail("no send_email step");
    if (email.recipientNameFieldName !== "customerFirstName") {
      fail(`send_email recipientNameFieldName ${email.recipientNameFieldName} — customEventSchema has no customerFullName`);
    }
    if (email.emailAddressFieldName !== "customerEmail") {
      fail(`send_email emailAddressFieldName ${email.emailAddressFieldName}`);
    }
    console.log("✓ send_email on custom_event → customerFirstName (schema has no customerFullName)");
  }

  // ── An explicit eventName wins over the metric name ───────────────────────
  {
    const r = await parseFlow(metricFlow(), metrics, {
      teamId: "t",
      forcedTrigger: customEventResolution("okendo_survey_submitted"),
    });
    const trig: any = r.automation?.steps.find((s: any) => s.type === StepType.TRIGGER);
    if (trig?.eventName !== "okendo_survey_submitted") fail(`explicit eventName lost: ${trig?.eventName}`);
    console.log("✓ explicit eventName overrides the metric name");
  }

  // ── Regression: every other schema keeps customerFullName ─────────────────
  {
    if (recipientNameFieldForSchema(SchemaType.MARKETING_CART_ABANDONMENT) !== "customerFullName") {
      fail("marketing schemas must keep customerFullName");
    }
    const r = await parseFlow(metricFlow(), { m1: { id: "m1", name: "Started Checkout" } as any }, { teamId: "t" });
    const trig: any = r.automation?.steps.find((s: any) => s.type === StepType.TRIGGER);
    if (trig?.eventName !== undefined) fail("non-custom-event trigger must not carry eventName");
    const email: any = r.automation?.steps.find((s: any) => s.type === StepType.SEND_EMAIL);
    if (email?.recipientNameFieldName !== "customerFullName") {
      fail(`marketing send_email recipientNameFieldName ${email?.recipientNameFieldName}`);
    }
    console.log("✓ marketing flows unchanged: no eventName, customerFullName preserved");
  }

  console.log("\nAll custom-event-trigger smoke checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

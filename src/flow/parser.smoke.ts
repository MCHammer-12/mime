/**
 * Smoke test for the trigger-recovery path: build a synthetic Klaviyo
 * flow with an unknown trigger, run parseFlow without override (expect
 * recoverable skip), then re-run with forcedTrigger and verify a usable
 * AdvancedFlow comes out.
 *
 *   npx tsx src/flow/parser.smoke.ts
 */
import { parseFlow } from "./parser.js";
import { MARKETING_TRIGGER_OPTIONS } from "./marketing-trigger-options.js";
import type { KlaviyoFlow } from "./types.js";

const fakeFlow = {
  data: {
    id: "flow-test",
    type: "flow",
    attributes: {
      name: "Test flow with unknown trigger",
      status: "draft",
      definition: {
        triggers: [
          {
            type: "metric",
            id: "metric-completely-custom",
          },
        ],
        actions: [],
      },
    },
  },
} as unknown as KlaviyoFlow;

async function main() {
  // First pass: no metrics catalog, no override → recoverable skip.
  const first = await parseFlow(fakeFlow, {}, { teamId: "team-x" });
  console.log("first pass automation:", first.automation === null ? "null" : "object");
  console.log("first pass skipped:", JSON.stringify(first.skipped));
  console.log("first pass warnings:", first.warnings.length);

  if (!first.skipped?.recoverable) {
    console.error("FAIL: expected recoverable=true on the first pass");
    process.exit(1);
  }

  // Second pass: pick the cart-abandonment trigger and re-parse.
  const cart = MARKETING_TRIGGER_OPTIONS.find((o) => o.value === "cart_abandonment");
  if (!cart) throw new Error("cart_abandonment trigger option missing");

  const second = await parseFlow(fakeFlow, {}, {
    teamId: "team-x",
    forcedTrigger: cart.resolution,
  });
  console.log("second pass automation:", second.automation === null ? "null" : "object");
  console.log("second pass schemaType:", second.automation?.schemaType);
  console.log("second pass step count:", second.automation?.steps.length);

  if (!second.automation) {
    console.error("FAIL: expected an automation when forcedTrigger is set");
    process.exit(1);
  }
  console.log("✓ parseFlow trigger override OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

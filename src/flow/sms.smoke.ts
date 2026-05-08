/**
 * Smoke test for Klaviyo send-sms → Redo SendSmsStep + placeholder
 * SmsTemplate. Runs against the welcome-sms fixture in
 * migrations/test-account/flows.
 *
 *   npx tsx src/flow/sms.smoke.ts
 */
import { readFileSync } from "node:fs";
import { parseFlow } from "./parser.js";
import { StepType, type KlaviyoFlow } from "./types.js";

// migrations/ may live alongside the worktree's parent mime checkout when
// running from `.claude/worktrees/<name>`. Walk up looking for it.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
const FIXTURE_REL = "migrations/test-account/flows/W4wnV8-welcome-sms.json";
function resolveFixture(): string {
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(process.cwd(), "../".repeat(i) + FIXTURE_REL);
    if (existsSync(candidate)) return candidate;
  }
  return FIXTURE_REL;
}
const FIXTURE = resolveFixture();

async function main() {
  const flow = JSON.parse(readFileSync(FIXTURE, "utf-8")) as KlaviyoFlow;
  const r = await parseFlow(flow, {}, { teamId: "team-x" });

  if (!r.automation) {
    console.error("FAIL: expected an automation, got:", r.skipped);
    process.exit(1);
  }

  const smsSteps = r.automation.steps.filter((s) => s.type === StepType.SEND_SMS);
  if (smsSteps.length === 0) {
    console.error("FAIL: expected at least one send_sms step");
    process.exit(1);
  }

  if (r.placeholderSmsTemplates.length !== smsSteps.length) {
    console.error(
      `FAIL: ${smsSteps.length} send_sms steps but ${r.placeholderSmsTemplates.length} SMS placeholders — must match 1:1`,
    );
    process.exit(1);
  }

  for (const step of smsSteps) {
    const s = step as any;
    if (typeof s.templateId !== "string" || s.templateId.length === 0) {
      console.error(`FAIL: send_sms step ${s.id} has empty templateId`);
      process.exit(1);
    }
    if (s.phoneNumberFieldName !== "customerPhone") {
      console.error(
        `FAIL: send_sms step ${s.id} has phoneNumberFieldName=${s.phoneNumberFieldName}, expected customerPhone`,
      );
      process.exit(1);
    }
    if (s.recipientNameFieldName !== "customerFirstName") {
      console.error(
        `FAIL: send_sms step ${s.id} has recipientNameFieldName=${s.recipientNameFieldName}, expected customerFirstName`,
      );
      process.exit(1);
    }
    const matchingPlaceholder = r.placeholderSmsTemplates.find(
      (p) => p.sentinelId === s.templateId,
    );
    if (!matchingPlaceholder) {
      console.error(
        `FAIL: send_sms step ${s.id} templateId ${s.templateId} has no matching placeholderSmsTemplate`,
      );
      process.exit(1);
    }
    if (!matchingPlaceholder.content || !matchingPlaceholder.content.trim()) {
      console.error(
        `FAIL: SMS placeholder ${matchingPlaceholder.sentinelId} has empty content`,
      );
      process.exit(1);
    }
    if (matchingPlaceholder.schemaType !== r.automation.schemaType) {
      console.error(
        `FAIL: SMS placeholder schemaType=${matchingPlaceholder.schemaType} doesn't match flow schemaType=${r.automation.schemaType}`,
      );
      process.exit(1);
    }
    if (typeof matchingPlaceholder.autoShortenLinks !== "boolean") {
      console.error(
        `FAIL: SMS placeholder ${matchingPlaceholder.sentinelId} missing autoShortenLinks (must be true/false to override Redo's mongoose default)`,
      );
      process.exit(1);
    }
  }

  // Behavior assertion: the test fixture has shorten_links: true, so the
  // placeholder must mirror that. Negative case (false default) is covered
  // by the inline check below.
  const fixtureExpectedShorten = true;
  const fixturePh = r.placeholderSmsTemplates[0];
  if (fixturePh.autoShortenLinks !== fixtureExpectedShorten) {
    console.error(
      `FAIL: fixture has shorten_links=${fixtureExpectedShorten}, placeholder emitted autoShortenLinks=${fixturePh.autoShortenLinks}`,
    );
    process.exit(1);
  }

  // Synthesize an SMS-only flow with shorten_links absent to confirm the
  // explicit-false branch.
  const synthesized: any = {
    data: {
      ...flow.data,
      attributes: {
        ...flow.data.attributes,
        definition: {
          ...flow.data.attributes.definition,
          actions: flow.data.attributes.definition.actions.map((a: any) => {
            if (a.type !== "send-sms") return a;
            const cloned = JSON.parse(JSON.stringify(a));
            delete cloned.data?.message?.shorten_links;
            return cloned;
          }),
        },
      },
    },
  };
  const r2 = await parseFlow(synthesized as KlaviyoFlow, {}, { teamId: "team-x" });
  if (r2.placeholderSmsTemplates[0]?.autoShortenLinks !== false) {
    console.error(
      `FAIL: missing shorten_links should emit autoShortenLinks=false, got ${r2.placeholderSmsTemplates[0]?.autoShortenLinks}`,
    );
    process.exit(1);
  }
  console.log(
    `✓ autoShortenLinks: explicit-true mirrored, missing → false (overrides Redo mongoose default)`,
  );

  console.log(
    `✓ ${FIXTURE.split("/").pop()}: ${smsSteps.length} send_sms steps, ${r.placeholderSmsTemplates.length} placeholders, schemaType=${r.automation.schemaType}`,
  );
  for (const p of r.placeholderSmsTemplates) {
    console.log(`  ${p.sentinelId.slice(0, 8)}… [${p.name}] "${p.content.slice(0, 60).replace(/\n/g, " ")}"`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

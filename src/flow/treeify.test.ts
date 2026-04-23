// Smoke test for treeifyFlow. Runs synthetic fixtures through the transform
// and prints the result. Not part of a test framework — just:
//   npx tsx src/flow/treeify.test.ts

import { treeifyFlow } from "./treeify.js";
import {
  MarketingTriggerKey,
  SchemaType,
  StepType,
  WaitTimeUnit,
  type ParseWarning,
  type Step,
} from "./types.js";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function run(label: string, steps: Step[]): {
  out: Step[];
  warnings: ParseWarning[];
} {
  console.log(`\n=== ${label} ===`);
  const warnings: ParseWarning[] = [];
  const out = treeifyFlow(steps, warnings);
  for (const s of out) {
    const p =
      s.type === StepType.CONDITION
        ? `T→${s.nextTrueId} F→${s.nextFalseId}`
        : "nextId" in s && s.nextId
          ? `→${s.nextId}`
          : "(end)";
    console.log(`  ${s.id.padEnd(24)} ${s.type.padEnd(14)} ${p}`);
  }
  for (const w of warnings) {
    console.log(`  WARNING ${w.kind}: ${w.message}`);
  }
  return { out, warnings };
}

// Fixture 1: no merges — should be byte-identical.
{
  const steps: Step[] = [
    {
      type: StepType.TRIGGER,
      id: "trigger",
      schemaType: SchemaType.EMAIL_MARKETING_SIGNUP,
      category: "Marketing",
      key: MarketingTriggerKey.EMAIL_SIGNUP,
      nextId: "email1",
    },
    {
      type: StepType.SEND_EMAIL,
      id: "email1",
      templateId: "tpl1",
      emailAddressFieldName: "customerEmail",
      recipientNameFieldName: "customerFullName",
      nextId: "wait1",
    },
    {
      type: StepType.WAIT,
      id: "wait1",
      timeUnit: WaitTimeUnit.DAYS,
      numDays: 1,
      nextId: "email2",
    },
    {
      type: StepType.SEND_EMAIL,
      id: "email2",
      templateId: "tpl2",
      emailAddressFieldName: "customerEmail",
      recipientNameFieldName: "customerFullName",
    },
  ];
  const { out, warnings } = run("no-merge flow (linear)", steps);
  assert(out.length === steps.length, "step count unchanged");
  assert(out.every((s, i) => s.id === steps[i].id), "ids unchanged");
  assert(warnings.length === 0, "no warnings");
}

// Fixture 2: classic merge — branch, both branches point at email3.
{
  const steps: Step[] = [
    {
      type: StepType.TRIGGER,
      id: "trigger",
      schemaType: SchemaType.EMAIL_MARKETING_SIGNUP,
      category: "Marketing",
      key: MarketingTriggerKey.EMAIL_SIGNUP,
      nextId: "cond1",
    },
    {
      type: StepType.CONDITION,
      id: "cond1",
      expression: {},
      nextTrueId: "email1",
      nextFalseId: "email2",
    },
    {
      type: StepType.SEND_EMAIL,
      id: "email1",
      templateId: "tpl1",
      emailAddressFieldName: "customerEmail",
      recipientNameFieldName: "customerFullName",
      nextId: "email3",
    },
    {
      type: StepType.SEND_EMAIL,
      id: "email2",
      templateId: "tpl2",
      emailAddressFieldName: "customerEmail",
      recipientNameFieldName: "customerFullName",
      nextId: "email3",
    },
    {
      type: StepType.SEND_EMAIL,
      id: "email3",
      templateId: "tpl3",
      emailAddressFieldName: "customerEmail",
      recipientNameFieldName: "customerFullName",
      nextId: "wait1",
    },
    {
      type: StepType.WAIT,
      id: "wait1",
      timeUnit: WaitTimeUnit.DAYS,
      numDays: 1,
      nextId: "email4",
    },
    {
      type: StepType.SEND_EMAIL,
      id: "email4",
      templateId: "tpl4",
      emailAddressFieldName: "customerEmail",
      recipientNameFieldName: "customerFullName",
    },
  ];
  const { out, warnings } = run("merge after branch (email3+tail duplicated)", steps);
  const ids = out.map((s) => s.id);
  assert(ids.includes("email3"), "first copy of email3 keeps original id");
  assert(ids.some((i) => i.startsWith("email3__dup_")), "second copy has __dup_ id");
  assert(ids.some((i) => i.startsWith("wait1__dup_")), "wait1 also duplicated (downstream of merge)");
  assert(ids.some((i) => i.startsWith("email4__dup_")), "email4 also duplicated (downstream of merge)");
  assert(out.length === 10, `step count is 10 (got ${out.length}) — 3 pre-merge + 3 each tail + nothing else`);
  assert(warnings.length === 0, "no warnings for reasonable merge");

  // Verify pointer correctness: email1 and email2 nextIds point at DIFFERENT copies of email3.
  const email1 = out.find((s) => s.id === "email1") as any;
  const email2 = out.find((s) => s.id === "email2") as any;
  assert(email1.nextId !== email2.nextId, "email1 and email2 point at distinct email3 clones");
  assert(email1.nextId === "email3" || email2.nextId === "email3", "one of them keeps original email3");
}

// Fixture 3: cycle guard — email1 points back at itself (shouldn't happen in
// real Klaviyo data but the guard exists for safety).
{
  const steps: Step[] = [
    {
      type: StepType.TRIGGER,
      id: "trigger",
      schemaType: SchemaType.EMAIL_MARKETING_SIGNUP,
      category: "Marketing",
      key: MarketingTriggerKey.EMAIL_SIGNUP,
      nextId: "email1",
    },
    {
      type: StepType.SEND_EMAIL,
      id: "email1",
      templateId: "tpl1",
      emailAddressFieldName: "customerEmail",
      recipientNameFieldName: "customerFullName",
      nextId: "email1",
    },
  ];
  const { out, warnings } = run("cycle (email1 → email1)", steps);
  assert(
    warnings.some((w) => w.message.includes("cycle")),
    "cycle warning emitted",
  );
  const email1 = out.find((s) => s.id === "email1") as any;
  assert(email1.nextId === "flow_end", "email1.nextId redirected to flow_end");
}

// Fixture 4: diamond with condition (both branches of cond1 lead to cond2 via
// distinct paths, cond2 has its own merge to email_shared).
{
  const steps: Step[] = [
    {
      type: StepType.TRIGGER,
      id: "trigger",
      schemaType: SchemaType.EMAIL_MARKETING_SIGNUP,
      category: "Marketing",
      key: MarketingTriggerKey.EMAIL_SIGNUP,
      nextId: "cond1",
    },
    {
      type: StepType.CONDITION,
      id: "cond1",
      expression: {},
      nextTrueId: "email_a",
      nextFalseId: "email_b",
    },
    {
      type: StepType.SEND_EMAIL,
      id: "email_a",
      templateId: "tpl_a",
      emailAddressFieldName: "customerEmail",
      recipientNameFieldName: "customerFullName",
      nextId: "email_shared",
    },
    {
      type: StepType.SEND_EMAIL,
      id: "email_b",
      templateId: "tpl_b",
      emailAddressFieldName: "customerEmail",
      recipientNameFieldName: "customerFullName",
      nextId: "email_shared",
    },
    {
      type: StepType.SEND_EMAIL,
      id: "email_shared",
      templateId: "tpl_shared",
      emailAddressFieldName: "customerEmail",
      recipientNameFieldName: "customerFullName",
    },
  ];
  const { out } = run("diamond merge (email_shared is tail)", steps);
  const sharedIds = out.filter((s) => s.id.startsWith("email_shared")).map((s) => s.id);
  assert(sharedIds.length === 2, `2 copies of email_shared (got ${sharedIds.length}: ${sharedIds.join(", ")})`);
}

console.log("\nAll assertions passed.");

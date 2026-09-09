/** Smoke test for the vacuous-condition guard.
 *
 *   npx tsx src/flow/vacuous-conditions.smoke.ts
 */

import { StepType, type Step } from "./types.js";
import { collapseVacuousConditions, findVacuousConditions } from "./vacuous-conditions.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function condition(expression: unknown): Step {
  return {
    type: StepType.CONDITION,
    id: "split",
    expression,
    nextTrueId: "send",
    nextFalseId: "nothing",
  } as Step;
}

const tail: Step[] = [
  { type: StepType.SEND_EMAIL, id: "send" } as Step,
  { type: StepType.DO_NOTHING, id: "nothing" } as Step,
];

// ─── Empty inline segment matches nobody — the true branch is dead ───

const empty = findVacuousConditions([
  condition({ dataSource: "inline-segment", inlineSegment: { mode: "AND", conditions: [] } }),
  ...tail,
]);
if (empty.length !== 1) fail(`empty inline segment: expected 1 vacuous condition, got ${empty.length}`);
if (empty[0].id !== "split") fail("empty inline segment: wrong step id");
if (empty[0].trueBranchType !== StepType.SEND_EMAIL) fail("empty inline segment: wrong true-branch type");
console.log("✓ empty inline segment flagged");

// ─── A translated filter is fine ───

const populated = findVacuousConditions([
  condition({
    dataSource: "inline-segment",
    inlineSegment: {
      mode: "AND",
      conditions: [{ type: "customer_attribute", whereCondition: {} }],
    },
  }),
  ...tail,
]);
if (populated.length !== 0) fail("populated inline segment: should not be flagged");
console.log("✓ populated inline segment passes");

// ─── Other data sources are not inline segments ───

const triggerData = findVacuousConditions([
  condition({
    dataSource: "trigger-data",
    schemaBooleanExpression: { type: "text_match", field: "segment", operator: "equals", matchValues: ["x"] },
  }),
  ...tail,
]);
if (triggerData.length !== 0) fail("trigger-data: should not be flagged");
console.log("✓ trigger-data condition passes (SEGMENT_ID gate)");

// ─── A missing inlineSegment is just as vacuous ───

const missing = findVacuousConditions([condition({ dataSource: "inline-segment" }), ...tail]);
if (missing.length !== 1) fail("missing inlineSegment: expected 1 vacuous condition");
console.log("✓ missing inlineSegment flagged");

// ─── Non-condition steps are ignored ───

const noConditions = findVacuousConditions(tail);
if (noConditions.length !== 0) fail("non-condition steps: should not be flagged");
console.log("✓ non-condition steps ignored");

// ─── Collapsing redirects the parent to the true branch and drops the step ───

{
  const warnings: any[] = [];
  const steps: Step[] = [
    { type: StepType.TRIGGER, id: "trigger", nextId: "split" } as Step,
    condition({ dataSource: "inline-segment", inlineSegment: { mode: "AND", conditions: [] } }),
    ...tail,
  ];
  const collapsed = collapseVacuousConditions(steps, warnings);
  if (collapsed.some((s) => s.id === "split")) fail("collapse: dead gate survived");
  const trigger = collapsed.find((s) => s.id === "trigger") as any;
  if (trigger.nextId !== "send") fail(`collapse: must take the true branch, got ${trigger.nextId}`);
  if (findVacuousConditions(collapsed).length !== 0) fail("collapse: still vacuous");
  if (warnings.length !== 1 || warnings[0].kind !== "degraded-mapping") {
    fail("collapse: expected one degraded-mapping warning");
  }
  console.log("✓ collapse redirects to the true branch and warns");
}

// ─── Nothing to collapse leaves the graph untouched ───

{
  const steps: Step[] = [
    condition({
      dataSource: "trigger-data",
      schemaBooleanExpression: { type: "text_match", field: "segment", operator: "equals", matchValues: ["x"] },
    }),
    ...tail,
  ];
  const warnings: any[] = [];
  const same = collapseVacuousConditions(steps, warnings);
  if (same.length !== steps.length) fail("collapse: dropped a translatable condition");
  if (warnings.length !== 0) fail("collapse: warned with nothing to collapse");
  console.log("✓ translatable conditions survive collapse");
}

console.log("✓ vacuous-condition smoke tests pass");

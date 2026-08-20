/** Smoke test for the vacuous-condition guard.
 *
 *   npx tsx src/flow/vacuous-conditions.smoke.ts
 */

import { StepType, type Step } from "./types.js";
import { findVacuousConditions } from "./vacuous-conditions.js";

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
  { type: StepType.DO_NOTHING, id: "send" } as Step,
  { type: StepType.DO_NOTHING, id: "nothing" } as Step,
];

// ─── Empty inline segment matches everyone ───

const empty = findVacuousConditions([
  condition({ dataSource: "inline-segment", inlineSegment: { mode: "AND", conditions: [] } }),
  ...tail,
]);
if (empty.length !== 1) fail(`empty inline segment: expected 1 vacuous condition, got ${empty.length}`);
if (empty[0].id !== "split") fail("empty inline segment: wrong step id");
if (empty[0].falseBranchType !== StepType.DO_NOTHING) fail("empty inline segment: wrong false-branch type");
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

console.log("✓ vacuous-condition smoke tests pass");

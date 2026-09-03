// A CONDITION step whose expression is an inline segment with zero conditions
// matches *nobody*. redoapp's condition-evaluator routes
// `dataSource: "inline-segment"` to doesCustomerMatchSegmentQuery, which wraps
// the block and short-circuits: "A condition block with no conditions should not
// match any customer" (redo/marketing/db/util/src/segments/
// evaluate-segment-membership.ts:184). The branch always takes the false path;
// the true path never runs.
//
// Klaviyo filters no translator understands fall through to a placeholder that
// warns and contributes no condition, so a split built only from un-translatable
// filters lands here. That is a *silently wrong send*, not a degraded one — the
// flow looks imported and behaves differently from Klaviyo with nothing to show
// for it — so the import blocks on it instead of warning.

import { StepType, type Step } from "./types.js";

export interface VacuousCondition {
  id: string;
  nextTrueId: string;
  nextFalseId: string;
  /** Step type the true branch heads into — what will never run. */
  trueBranchType: string;
}

function isVacuousExpression(expression: unknown): boolean {
  if (typeof expression !== "object" || expression === null) return false;
  const expr = expression as { dataSource?: unknown; inlineSegment?: unknown };
  if (expr.dataSource !== "inline-segment") return false;
  const seg = expr.inlineSegment as { conditions?: unknown } | undefined | null;
  if (!seg || typeof seg !== "object") return true;
  return !Array.isArray(seg.conditions) || seg.conditions.length === 0;
}

export function findVacuousConditions(steps: Step[]): VacuousCondition[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const out: VacuousCondition[] = [];
  for (const step of steps) {
    if (step.type !== StepType.CONDITION) continue;
    if (!isVacuousExpression(step.expression)) continue;
    out.push({
      id: step.id,
      nextTrueId: step.nextTrueId,
      nextFalseId: step.nextFalseId,
      trueBranchType: byId.get(step.nextTrueId)?.type ?? "missing",
    });
  }
  return out;
}

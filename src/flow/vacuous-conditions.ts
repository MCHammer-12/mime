// A CONDITION step whose expression is an inline segment with zero conditions
// matches *everyone*. redoapp's condition-evaluator routes
// `dataSource: "inline-segment"` to doesCustomerMatchSegmentQuery, and an empty
// AND query is vacuously true (redo/flows/service/src/condition-evaluator.ts).
// The branch always takes the true path; the false path never runs.
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
  /** Step type the false branch heads into — what will never run. */
  falseBranchType: string;
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
      falseBranchType: byId.get(step.nextFalseId)?.type ?? "missing",
    });
  }
  return out;
}

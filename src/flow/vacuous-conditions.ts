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

import { StepType, type ParseWarning, type Step } from "./types.js";

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

// Collapsing is the other half of the guard. Blocking the import is right when
// the filter is recoverable; when nothing in Redo can express it, the choice is
// between two wrong flows — import as-is and the true branch (usually a real,
// built email) never sends, or take the true branch unconditionally and
// over-send it to the slice Klaviyo would have excluded. The second loses less,
// so `COLLAPSE_VACUOUS_CONDITIONS=1` redirects to the true branch and drops the
// step. Same shape and same reasoning as collapseConsentSplits.
//
// First case: Invader Concepts "Loyalty Program Welcome", whose split is
// "hasn't completed a Smile referral in 7 days". Redo has no referral activity
// and ingests no Smile events, so the condition can only ever match nobody.
export function collapseVacuousConditions(
  steps: Step[],
  warnings: ParseWarning[],
): Step[] {
  const redirect = new Map<string, string>();
  for (const v of findVacuousConditions(steps)) redirect.set(v.id, v.nextTrueId);
  if (redirect.size === 0) return steps;

  function resolve(id: string): string {
    const seen = new Set<string>();
    let cur = id;
    while (redirect.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = redirect.get(cur)!;
    }
    return cur;
  }

  const out: Step[] = [];
  for (const s of steps) {
    if (redirect.has(s.id)) continue;
    switch (s.type) {
      case StepType.CONDITION:
        s.nextTrueId = resolve(s.nextTrueId);
        s.nextFalseId = resolve(s.nextFalseId);
        break;
      case StepType.AB_TEST:
        s.variants = s.variants.map((v) => ({ ...v, nextId: resolve(v.nextId) }));
        break;
      default:
        if (s.nextId) s.nextId = resolve(s.nextId);
        break;
    }
    out.push(s);
  }

  warnings.push({
    kind: "degraded-mapping",
    message:
      `collapsed ${redirect.size} untranslatable condition(s) to their true branch — ` +
      `everyone who reaches the step now takes it. Rebuild the filter in the flow ` +
      `builder if the excluded audience matters.`,
  });

  return out;
}

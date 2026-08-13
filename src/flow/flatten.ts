// Pre-treeify simplification of Klaviyo branch structure.
//
// Klaviyo authors defensively: it re-tests the same predicate at every decision
// point, and it guards every SMS send with a "can this profile receive SMS?"
// split. Redo's advanced-flow model is a tree, so every one of those splits
// doubles the subtree below it (see treeify.ts). A welcome series with 7 splits
// over 2 distinct predicates expands ~25x.
//
// Two rewrites, both authorized by Michael (2026-08-10):
//
//   1. Channel-consent splits ("is subscribed to SMS/email") are dropped and
//      the send-side branch is always taken. Redo already suppresses sends to
//      profiles without consent, so the branch is redundant machinery.
//
//   2. Repeated identical predicates are folded on the path that already
//      decided them — implemented in treeify.ts, where the root-to-node path
//      exists.

import {
  StepType,
  type ParseWarning,
  type Step,
} from "./types.js";

// Klaviyo consent splits map to a single-condition inline segment on
// `subscribed-to-sms` / `subscribed-to-email` (see condition-mapping.ts).
// Match only that exact shape — a consent check ANDed with anything else is a
// real business rule and must survive.
function consentDimension(expression: unknown): string | null {
  const conds = (expression as any)?.inlineSegment?.conditions;
  if (!Array.isArray(conds) || conds.length !== 1) return null;
  const w = conds[0]?.type === "customer_attribute" ? conds[0].whereCondition : null;
  const dim = w?.dimension;
  if (dim !== "subscribed-to-sms" && dim !== "subscribed-to-email") return null;
  // Only a positive consent test is redundant. `subscribed = false` selects the
  // *un*subscribed population, which is a real audience split.
  return w?.comparison?.value === true ? dim : null;
}

export function collapseConsentSplits(
  steps: Step[],
  warnings: ParseWarning[],
): Step[] {
  const redirect = new Map<string, string>();
  for (const s of steps) {
    if (s.type !== StepType.CONDITION) continue;
    const dim = consentDimension(s.expression);
    if (dim) redirect.set(s.id, s.nextTrueId);
  }
  if (redirect.size === 0) return steps;

  // A consent split can point straight at another one; resolve the chain.
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
    message: `collapsed ${redirect.size} channel-consent split(s); the send branch is always taken (Redo suppresses sends to profiles without consent)`,
  });

  return out;
}

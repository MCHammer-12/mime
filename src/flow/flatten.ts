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
//      Only when the other branch really is machinery. Klaviyo authors two
//      different things with the same split shape:
//
//        guard     consent? → send SMS ; else → skip ahead to the next step
//        fallback  consent? → send SMS ; else → send the SAME message by email
//
//      The guard is redundant and collapses. The fallback is a real audience
//      split — collapsing it deletes the email that everyone without a phone
//      number was supposed to get. Seen at Any Means Necessary 2026-09-09:
//      three Reclaim flows, five fallback splits, five emails that would have
//      vanished. So a split only collapses when the non-send branch reaches
//      the join without sending anything of its own.
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

function nextIds(s: Step): string[] {
  if (s.type === StepType.CONDITION) return [s.nextTrueId, s.nextFalseId];
  if (s.type === StepType.AB_TEST) return s.variants.map((v) => v.nextId);
  return (s as { nextId?: string }).nextId ? [(s as { nextId: string }).nextId] : [];
}

function reachable(byId: Map<string, Step>, from: string): Set<string> {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const s = byId.get(id);
    if (s) stack.push(...nextIds(s));
  }
  return seen;
}

// True when the false branch is pure bypass: it rejoins the true branch (or
// runs out) without a send of its own. That is the guard shape, and only the
// guard shape is safe to collapse — see the header.
function falseBranchOnlySkips(byId: Map<string, Step>, split: Step & { type: StepType.CONDITION }): boolean {
  const join = reachable(byId, split.nextTrueId);
  const seen = new Set<string>();
  const stack = [split.nextFalseId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || join.has(id)) continue;
    seen.add(id);
    const s = byId.get(id);
    if (!s) continue;
    if (s.type === StepType.SEND_EMAIL || s.type === StepType.SEND_SMS) return false;
    stack.push(...nextIds(s));
  }
  return true;
}

export function collapseConsentSplits(
  steps: Step[],
  warnings: ParseWarning[],
): Step[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const redirect = new Map<string, string>();
  const kept: string[] = [];
  for (const s of steps) {
    if (s.type !== StepType.CONDITION) continue;
    const dim = consentDimension(s.expression);
    if (!dim) continue;
    if (falseBranchOnlySkips(byId, s)) redirect.set(s.id, s.nextTrueId);
    else kept.push(s.id);
  }
  if (kept.length > 0) {
    warnings.push({
      kind: "degraded-mapping",
      message:
        `kept ${kept.length} channel-consent split(s) whose other branch sends on a different channel ` +
        `(${kept.join(", ")}) — an SMS-or-email fallback, not a redundant guard. Redo evaluates ` +
        `subscribed-to-sms as current state, so a profile that has since opted out takes the email branch.`,
    });
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

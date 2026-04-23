// DAG → tree transformation for Redo advanced-flow steps.
//
// Klaviyo flows can have two branches reconverge on a shared downstream
// action. Redo's advanced-flow model is a tree — each step has at most one
// parent. When a step is reachable by >1 parent, we clone it (and its whole
// descendant subtree) so each incoming branch gets its own copy. Semantics
// are preserved: each customer still traverses exactly one path, and sends
// the same sequence of messages they would have in Klaviyo.

import {
  StepType,
  type ConditionStep,
  type DoNothingStep,
  type ParseWarning,
  type SendEmailStep,
  type SendSmsStep,
  type SendWebhookStep,
  type Step,
  type TriggerStep,
  type WaitStep,
} from "./types.js";

const TRIGGER_STEP_ID = "trigger";
const FLOW_END_ID = "flow_end";
const BLOWUP_RATIO_WARN = 10;

export function treeifyFlow(
  steps: Step[],
  warnings: ParseWarning[],
): Step[] {
  const byId = new Map<string, Step>();
  for (const s of steps) byId.set(s.id, s);

  const trigger = byId.get(TRIGGER_STEP_ID) as TriggerStep | undefined;
  if (!trigger) return steps;

  const emittedCount = new Map<string, number>();
  const dfsStack = new Set<string>();
  const out: Step[] = [];

  function nextClonedId(origId: string): string {
    const origStep = byId.get(origId);
    if (!origStep) return origId;

    if (dfsStack.has(origId)) {
      warnings.push({
        kind: "degraded-mapping",
        actionId: origId,
        message: `flow cycle detected at action ${origId}; redirected to a fresh flow_end`,
      });
      // Break the cycle by pointing at a fresh end-of-flow terminal.
      return nextClonedId(FLOW_END_ID);
    }

    const count = emittedCount.get(origId) ?? 0;
    emittedCount.set(origId, count + 1);
    const newId = count === 0 ? origId : `${origId}__dup_${count}`;

    const cloned = cloneStepWithNewId(origStep, newId);
    // Push pre-order so the output array mirrors the tree walk from the root
    // (parent before children). Pointers on `cloned` are still the original
    // ids at this point — rewritePointers below mutates them in place.
    out.push(cloned);

    dfsStack.add(origId);
    rewritePointers(cloned);
    dfsStack.delete(origId);

    return newId;
  }

  function rewritePointers(step: Step): void {
    switch (step.type) {
      case StepType.TRIGGER:
      case StepType.WAIT:
        step.nextId = nextClonedId(step.nextId);
        return;
      case StepType.SEND_EMAIL:
      case StepType.SEND_SMS:
      case StepType.DO_NOTHING:
        if (step.nextId) step.nextId = nextClonedId(step.nextId);
        return;
      case StepType.SEND_WEBHOOK:
        if (step.nextId) step.nextId = nextClonedId(step.nextId);
        return;
      case StepType.CONDITION:
        step.nextTrueId = nextClonedId(step.nextTrueId);
        step.nextFalseId = nextClonedId(step.nextFalseId);
        return;
    }
  }

  // Start from the trigger's first pointer. The trigger itself stays put
  // with its original id — it's the single entry point.
  dfsStack.add(TRIGGER_STEP_ID);
  const triggerClone: TriggerStep = { ...trigger };
  triggerClone.nextId = nextClonedId(trigger.nextId);
  dfsStack.delete(TRIGGER_STEP_ID);
  out.unshift(triggerClone);

  const ratio = steps.length > 0 ? out.length / steps.length : 1;
  if (ratio > BLOWUP_RATIO_WARN) {
    warnings.push({
      kind: "degraded-mapping",
      message: `flow tree expanded ${ratio.toFixed(1)}x (from ${steps.length} to ${out.length} steps) after branch-merge duplication; heavy merge structure detected`,
    });
  }

  return out;
}

// Shallow clone with a replaced id. We mutate nextId/nextTrueId/nextFalseId
// after this returns via rewritePointers. Using a discriminated union so
// TypeScript preserves each variant's field set.
function cloneStepWithNewId(step: Step, newId: string): Step {
  switch (step.type) {
    case StepType.TRIGGER:
      return { ...(step as TriggerStep), id: newId };
    case StepType.WAIT:
      return { ...(step as WaitStep), id: newId };
    case StepType.SEND_EMAIL:
      return { ...(step as SendEmailStep), id: newId };
    case StepType.SEND_SMS:
      return { ...(step as SendSmsStep), id: newId };
    case StepType.SEND_WEBHOOK:
      return { ...(step as SendWebhookStep), id: newId };
    case StepType.DO_NOTHING:
      return { ...(step as DoNothingStep), id: newId };
    case StepType.CONDITION:
      return { ...(step as ConditionStep), id: newId };
  }
}

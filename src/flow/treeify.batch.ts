// Batch-run treeify against raw Klaviyo flow definitions. Bypasses the full
// parseFlow pipeline (which wants metrics, template resolver, etc.) by
// constructing a minimal Step[] from each Klaviyo action. We only care about
// the pointer graph here, so every non-conditional-split/trigger-split action
// is emitted as a DO_NOTHING stub with `nextId: action.links.next`.
//
// Usage: npx tsx src/flow/treeify.batch.ts [merchant]
// Defaults to test-account.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { treeifyFlow } from "./treeify.js";
import {
  MarketingTriggerKey,
  SchemaType,
  StepType,
  type ConditionStep,
  type DoNothingStep,
  type KlaviyoAction,
  type KlaviyoFlow,
  type ParseWarning,
  type Step,
  type TriggerStep,
} from "./types.js";

const FLOW_END_ID = "flow_end";

function buildSyntheticSteps(flow: KlaviyoFlow): Step[] {
  const actions = flow.data.attributes.definition?.actions ?? [];
  const firstId = actions[0]?.id ?? FLOW_END_ID;

  const ids = new Set(actions.map((a) => a.id));
  let needsTerminal = false;
  const pointer = (p: string | null | undefined): string => {
    if (!p) {
      needsTerminal = true;
      return FLOW_END_ID;
    }
    if (!ids.has(p)) {
      needsTerminal = true;
      return FLOW_END_ID;
    }
    return p;
  };

  const trigger: TriggerStep = {
    type: StepType.TRIGGER,
    id: "trigger",
    schemaType: SchemaType.EMAIL_MARKETING_SIGNUP,
    category: "Marketing",
    key: MarketingTriggerKey.EMAIL_SIGNUP,
    nextId: pointer(firstId),
  };

  const steps: Step[] = [trigger];
  for (const a of actions) {
    const s = toStub(a, pointer);
    if (s) steps.push(s);
  }

  if (needsTerminal) {
    const end: DoNothingStep = {
      type: StepType.DO_NOTHING,
      id: FLOW_END_ID,
      customTitle: "End of flow",
    };
    steps.push(end);
  }

  return steps;
}

function toStub(
  a: KlaviyoAction,
  pointer: (p: string | null | undefined) => string,
): Step | null {
  if (a.type === "conditional-split" || a.type === "trigger-split") {
    const s: ConditionStep = {
      type: StepType.CONDITION,
      id: a.id,
      expression: {},
      nextTrueId: pointer(a.links?.next_if_true),
      nextFalseId: pointer(a.links?.next_if_false),
    };
    return s;
  }
  const s: DoNothingStep = {
    type: StepType.DO_NOTHING,
    id: a.id,
    nextId: pointer(a.links?.next),
  };
  return s;
}

function countInDegree(steps: Step[]): Map<string, number> {
  const deg = new Map<string, number>();
  for (const s of steps) {
    const children: string[] = [];
    if (s.type === StepType.CONDITION) {
      children.push(s.nextTrueId, s.nextFalseId);
    } else if ("nextId" in s && s.nextId) {
      children.push(s.nextId);
    }
    for (const c of children) {
      deg.set(c, (deg.get(c) ?? 0) + 1);
    }
  }
  return deg;
}

async function main() {
  const merchant = process.argv[2] ?? "test-account";
  const flowsDir = join("migrations", merchant, "flows");
  const files = (await readdir(flowsDir)).filter((f) => f.endsWith(".json"));

  let flowsWithMerges = 0;
  let flowsUnchanged = 0;
  let totalOriginalSteps = 0;
  let totalTreeifiedSteps = 0;
  const merges: Array<{ slug: string; before: number; after: number; merges: string[]; warnings: ParseWarning[] }> = [];

  for (const f of files) {
    const flow: KlaviyoFlow = JSON.parse(await readFile(join(flowsDir, f), "utf8"));
    if (!flow.data.attributes.definition) continue;
    const before = buildSyntheticSteps(flow);
    const inDeg = countInDegree(before);
    const mergeIds: string[] = [];
    for (const [id, deg] of inDeg) {
      if (id === FLOW_END_ID) continue;
      if (deg > 1) mergeIds.push(id);
    }
    const warnings: ParseWarning[] = [];
    const after = treeifyFlow(before, warnings);

    totalOriginalSteps += before.length;
    totalTreeifiedSteps += after.length;

    if (mergeIds.length > 0) {
      flowsWithMerges++;
      merges.push({ slug: f.replace(/\.json$/, ""), before: before.length, after: after.length, merges: mergeIds, warnings });
    } else {
      flowsUnchanged++;
      if (after.length !== before.length) {
        console.error(`REGRESSION: no merges detected in ${f} but step count changed ${before.length} → ${after.length}`);
        process.exit(1);
      }
    }
  }

  console.log(`\n${merchant}: ${files.length} flows`);
  console.log(`  flows with branch merges: ${flowsWithMerges}`);
  console.log(`  flows unchanged (no merges): ${flowsUnchanged}`);
  console.log(`  total steps: ${totalOriginalSteps} → ${totalTreeifiedSteps} (+${totalTreeifiedSteps - totalOriginalSteps})`);

  if (merges.length > 0) {
    console.log(`\nFlows where treeify made a difference:`);
    for (const m of merges) {
      console.log(`  ${m.slug.padEnd(60)} ${String(m.before).padStart(3)} → ${String(m.after).padStart(4)} (merges at: ${m.merges.slice(0, 3).join(", ")}${m.merges.length > 3 ? `, +${m.merges.length - 3} more` : ""})`);
      for (const w of m.warnings) {
        console.log(`    WARNING ${w.kind}: ${w.message}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

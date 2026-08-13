/**
 * Smoke test: Klaviyo branch flattening (see flatten.ts + treeify.ts).
 *
 *   npx tsx src/flow/flatten.smoke.ts
 *
 * Klaviyo re-tests the same predicate at every decision point and guards every
 * SMS send with a consent split. Treeified naively, n such splits produce 2^n
 * paths — a real Piperblue welcome series expanded 31 → 758 steps. The two
 * rewrites here keep the first split and let the rest inherit it.
 *
 * The safety property under test: flattening never invents a delivery sequence
 * a customer couldn't already receive. It only removes internally-inconsistent
 * ones (repeat-customer = yes at split 1, no at split 2).
 */
import { collapseConsentSplits } from "./flatten.js";
import { treeifyFlow } from "./treeify.js";
import { StepType, type ParseWarning, type Step } from "./types.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const repeatCustomer = {
  dataSource: "inline-segment",
  inlineSegment: {
    mode: "AND",
    conditions: [
      {
        type: "customer_activity",
        activityType: "order-placed",
        count: { type: "at_least_once" },
        timeframe: { type: "all-time" },
        whereConditions: [],
      },
    ],
  },
};

const smsConsent = {
  dataSource: "inline-segment",
  inlineSegment: {
    mode: "AND",
    conditions: [
      {
        type: "customer_attribute",
        whereCondition: {
          type: "boolean",
          dimension: "subscribed-to-sms",
          comparison: { type: "boolean", value: true },
        },
      },
    ],
  },
};

function email(id: string, nextId: string): Step {
  return { type: StepType.SEND_EMAIL, id, templateId: id, nextId } as unknown as Step;
}
function cond(id: string, expression: unknown, t: string, f: string): Step {
  return { type: StepType.CONDITION, id, expression, nextTrueId: t, nextFalseId: f };
}

// Root-to-leaf email sequences, with treeify's `__dup_N` suffixes stripped so
// two clones of the same send compare equal.
function sequences(steps: Step[]): Set<string> {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const out = new Set<string>();
  function walk(id: string, acc: string[], depth: number): void {
    if (depth > 500) fail("walk did not terminate");
    const s = byId.get(id);
    if (!s) return void out.add(acc.join(","));
    if (s.type === StepType.SEND_EMAIL) acc = [...acc, s.id.replace(/__dup_\d+/g, "")];
    if (s.type === StepType.CONDITION) {
      walk(s.nextTrueId, acc, depth + 1);
      walk(s.nextFalseId, acc, depth + 1);
      return;
    }
    const next = (s as { nextId?: string }).nextId;
    if (!next) return void out.add(acc.join(","));
    walk(next, acc, depth + 1);
  }
  const trigger = byId.get("trigger") as { nextId: string };
  walk(trigger.nextId, [], 0);
  return out;
}

// ── A repeated predicate must not multiply paths ────────────────────────────
// Three splits on the SAME predicate, each reconverging. Klaviyo shape:
//   c1 → (a1|b1) → c2 → (a2|b2) → c3 → (a3|b3) → end
{
  const steps: Step[] = [
    { type: StepType.TRIGGER, id: "trigger", nextId: "c1" } as unknown as Step,
    cond("c1", repeatCustomer, "a1", "b1"),
    email("a1", "c2"),
    email("b1", "c2"),
    cond("c2", repeatCustomer, "a2", "b2"),
    email("a2", "c3"),
    email("b2", "c3"),
    cond("c3", repeatCustomer, "a3", "b3"),
    email("a3", "end"),
    email("b3", "end"),
    { type: StepType.DO_NOTHING, id: "end" } as unknown as Step,
  ];
  const warnings: ParseWarning[] = [];
  const tree = treeifyFlow(steps, warnings);
  const seqs = sequences(tree);

  if (seqs.size !== 2) fail(`expected 2 paths after folding, got ${seqs.size}: ${[...seqs]}`);
  if (!seqs.has("a1,a2,a3")) fail(`missing all-true path, got ${[...seqs]}`);
  if (!seqs.has("b1,b2,b3")) fail(`missing all-false path, got ${[...seqs]}`);
  const conds = tree.filter((s) => s.type === StepType.CONDITION);
  if (conds.length !== 1) fail(`expected 1 surviving split, got ${conds.length}`);
  // c2 and c3 are each reached once per side of c1, so 4 instances fold.
  if (!warnings.some((w) => w.message.includes("folded 4 repeated condition"))) {
    fail(`missing fold warning: ${warnings.map((w) => w.message)}`);
  }
  console.log("✓ 3 identical splits → 1 split, 2 paths (not 8)");
}

// ── A *different* predicate must still branch ───────────────────────────────
{
  const other = { dataSource: "inline-segment", inlineSegment: { mode: "AND", conditions: [{ type: "customer_attribute", whereCondition: { dimension: "location-country" } }] } };
  const steps: Step[] = [
    { type: StepType.TRIGGER, id: "trigger", nextId: "c1" } as unknown as Step,
    cond("c1", repeatCustomer, "a1", "b1"),
    email("a1", "c2"),
    email("b1", "c2"),
    cond("c2", other, "a2", "b2"),
    email("a2", "end"),
    email("b2", "end"),
    { type: StepType.DO_NOTHING, id: "end" } as unknown as Step,
  ];
  const seqs = sequences(treeifyFlow(steps, []));
  if (seqs.size !== 4) fail(`distinct predicates must not fold; expected 4 paths, got ${seqs.size}`);
  console.log("✓ distinct predicates still branch (4 paths)");
}

// ── Consent splits collapse to the send branch ──────────────────────────────
{
  const steps: Step[] = [
    { type: StepType.TRIGGER, id: "trigger", nextId: "c1" } as unknown as Step,
    cond("c1", smsConsent, "sms", "skip"),
    email("sms", "end"),
    email("skip", "end"),
    { type: StepType.DO_NOTHING, id: "end" } as unknown as Step,
  ];
  const warnings: ParseWarning[] = [];
  const flat = collapseConsentSplits(steps, warnings);
  if (flat.some((s) => s.id === "c1")) fail("consent split survived");
  const trigger = flat.find((s) => s.id === "trigger") as { nextId: string };
  if (trigger.nextId !== "sms") fail(`consent collapse must take the send branch, got ${trigger.nextId}`);
  if (!warnings.some((w) => w.message.includes("collapsed 1 channel-consent split"))) {
    fail("missing consent-collapse warning");
  }
  console.log("✓ SMS consent split collapsed to the send branch");
}

// ── A negative consent test is a real audience split — keep it ──────────────
{
  const unsubscribed = JSON.parse(JSON.stringify(smsConsent));
  unsubscribed.inlineSegment.conditions[0].whereCondition.comparison.value = false;
  const steps: Step[] = [
    { type: StepType.TRIGGER, id: "trigger", nextId: "c1" } as unknown as Step,
    cond("c1", unsubscribed, "a", "b"),
    email("a", "end"),
    email("b", "end"),
    { type: StepType.DO_NOTHING, id: "end" } as unknown as Step,
  ];
  if (!collapseConsentSplits(steps, []).some((s) => s.id === "c1")) {
    fail("subscribed=false is a real audience split and must survive");
  }
  console.log("✓ subscribed=false split preserved");
}

// ── Consent ANDed with a business rule is not a bare consent guard ──────────
{
  const compound = JSON.parse(JSON.stringify(smsConsent));
  compound.inlineSegment.conditions.push({ type: "customer_activity", activityType: "order-placed" });
  const steps: Step[] = [
    { type: StepType.TRIGGER, id: "trigger", nextId: "c1" } as unknown as Step,
    cond("c1", compound, "a", "b"),
    email("a", "end"),
    email("b", "end"),
    { type: StepType.DO_NOTHING, id: "end" } as unknown as Step,
  ];
  if (!collapseConsentSplits(steps, []).some((s) => s.id === "c1")) {
    fail("compound condition must not be treated as a bare consent guard");
  }
  console.log("✓ compound consent+activity split preserved");
}

console.log("\nflatten smoke: all passed");

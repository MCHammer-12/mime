/**
 * Smoke test for Klaviyo list-update → Redo manage_static_segment.
 *
 *   npx tsx src/migrate/segment-resolution.smoke.ts
 *
 * Covers two units:
 *  - parser: a `list-update` action emits a manage_static_segment step
 *    carrying the `_klaviyoListId` marker + a degraded-mapping warning.
 *  - import: `resolveSegmentSteps` turns the marker into a real segmentId
 *    (resolved), or a chain-preserving WAIT (resolution failed), and leaves
 *    every other step untouched.
 */
import { parseFlow } from "../flow/parser.js";
import { MARKETING_TRIGGER_OPTIONS } from "../flow/marketing-trigger-options.js";
import type { KlaviyoFlow } from "../flow/types.js";
import { resolveSegmentSteps } from "./import-rpc.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// --- A synthetic flow whose one action adds the profile to a Klaviyo list. ---
const flowWithListUpdate = {
  data: {
    id: "flow-listupdate",
    type: "flow",
    attributes: {
      name: "Add to list flow",
      status: "draft",
      definition: {
        triggers: [{ type: "metric", id: "back_in_stock" }],
        actions: [
          {
            id: "act-list",
            type: "list-update",
            data: { list_id: "XxFujr", on_execution: true },
            links: { next: null },
          },
        ],
      },
    },
  },
} as unknown as KlaviyoFlow;

async function testParserEmitsSegmentStep() {
  const bis = MARKETING_TRIGGER_OPTIONS.find((o) => o.value === "back_in_stock");
  if (!bis) throw new Error("back_in_stock trigger option missing");

  const r = await parseFlow(flowWithListUpdate, {}, {
    teamId: "team-x",
    forcedTrigger: bis.resolution,
  });
  if (!r.automation) fail("expected an automation from the list-update flow");

  const seg = r.automation.steps.filter(
    (s: any) => s.type === "manage_static_segment",
  );
  if (seg.length !== 1) fail(`expected 1 manage_static_segment step, got ${seg.length}`);
  const step: any = seg[0];
  if (step.operation !== "add") fail(`expected operation "add", got ${step.operation}`);
  if (step._klaviyoListId !== "XxFujr") fail(`expected marker XxFujr, got ${step._klaviyoListId}`);
  if (step.segmentId !== "") fail(`expected empty pre-resolution segmentId, got ${step.segmentId}`);
  if (step.disabled !== false) fail("expected disabled=false");
  if (typeof step.nextId !== "string") fail("expected a string nextId");

  const warned = r.warnings.some(
    (w: any) => w.kind === "degraded-mapping" && /list-update/.test(w.message ?? ""),
  );
  if (!warned) fail("expected a degraded-mapping warning naming list-update");

  console.log("✓ parser: list-update → manage_static_segment + marker + warning");
}

async function testResolveSuccess() {
  let calls = 0;
  const steps = [
    { type: "trigger", id: "t", nextId: "seg" },
    { type: "manage_static_segment", id: "seg", operation: "add", segmentId: "", nextId: "end", disabled: false, _klaviyoListId: "XxFujr" },
    { type: "do_nothing", id: "end" },
  ];
  const { steps: out, warnings } = await resolveSegmentSteps(steps, async (listId) => {
    calls++;
    if (listId !== "XxFujr") fail(`unexpected listId ${listId}`);
    return "redo-seg-123";
  });
  if (calls !== 1) fail(`expected resolveListId called once, got ${calls}`);
  if (warnings.length !== 0) fail(`expected no warnings on success, got ${warnings.length}`);
  const seg: any = out.find((s) => s.type === "manage_static_segment");
  if (!seg) fail("manage_static_segment step disappeared on success");
  if (seg.segmentId !== "redo-seg-123") fail(`expected resolved segmentId, got ${seg.segmentId}`);
  if ("_klaviyoListId" in seg) fail("marker not stripped after resolution");
  if (seg.operation !== "add" || seg.nextId !== "end" || seg.disabled !== false) {
    fail("resolved step lost a required field");
  }
  // Untouched steps survive unchanged.
  if (!out.find((s) => s.type === "trigger") || !out.find((s) => s.type === "do_nothing")) {
    fail("non-segment steps were dropped");
  }
  console.log("✓ resolveSegmentSteps: resolved → segmentId set, marker stripped, others intact");
}

async function testResolveFailureBecomesWait() {
  const steps = [
    { type: "trigger", id: "t", nextId: "seg" },
    { type: "manage_static_segment", id: "seg", operation: "add", segmentId: "", nextId: "end", disabled: false, _klaviyoListId: "ZZ999" },
    { type: "do_nothing", id: "end" },
  ];
  const { steps: out, warnings } = await resolveSegmentSteps(steps, async () => null);
  if (warnings.length !== 1) fail(`expected 1 warning on failure, got ${warnings.length}`);
  if (out.find((s) => s.type === "manage_static_segment")) {
    fail("failed segment step should not remain as manage_static_segment");
  }
  const wait: any = out.find((s) => s.id === "seg");
  if (!wait || wait.type !== "wait") fail("expected the failed step replaced by a wait");
  if (wait.nextId !== "end") fail(`expected wait to preserve nextId "end", got ${wait.nextId}`);
  if (wait.numDays !== 0 || wait.numSeconds !== 0) fail("expected a 0-duration wait");
  if (wait.timeUnit !== "Minutes") fail(`expected timeUnit "Minutes", got ${wait.timeUnit}`);
  console.log("✓ resolveSegmentSteps: failed → chain-preserving WAIT + warning");
}

async function testAlreadyResolvedPassesThrough() {
  // A manage_static_segment with no marker (e.g. re-import) is left alone.
  const steps = [
    { type: "manage_static_segment", id: "seg", operation: "remove", segmentId: "already-set", nextId: "x", disabled: false },
  ];
  let calls = 0;
  const { steps: out, warnings } = await resolveSegmentSteps(steps, async () => {
    calls++;
    return "should-not-be-used";
  });
  if (calls !== 0) fail("resolveListId should not be called for a markerless segment step");
  if (warnings.length !== 0) fail("no warnings expected for a markerless segment step");
  if ((out[0] as any).segmentId !== "already-set") fail("markerless segmentId was mutated");
  console.log("✓ resolveSegmentSteps: markerless segment step passes through untouched");
}

async function main() {
  await testParserEmitsSegmentStep();
  await testResolveSuccess();
  await testResolveFailureBecomesWait();
  await testAlreadyResolvedPassesThrough();
  console.log("\nAll segment-resolution smoke checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

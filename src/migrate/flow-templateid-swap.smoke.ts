/**
 * Smoke test for the flow-email orphaned-templateId fix (Jack Henry,
 * 2026-06-23). Regression guard for the bug where importFlowRpc shipped
 * `__PLACEHOLDER_X__` sentinels to createAdvancedFlow instead of the real
 * Redo template `_id`s, silently orphaning every flow email.
 *
 *   npx tsx src/migrate/flow-templateid-swap.smoke.ts
 *
 * Stubs global.fetch to play the Redo server (no network), so the test is
 * hermetic. Covers:
 *   1. POSITIVE — a flow with 2 placeholder templates → both sentinels swapped
 *      to real ObjectIds; NO `__PLACEHOLDER_` survives in the posted automation.
 *   2. NEGATIVE — createEmailTemplate returns a response with no `_id` → import
 *      throws loudly (never POSTs createAdvancedFlow).
 *   3. UNIT — extractCreatedTemplateId across happy / nested / empty shapes.
 */
import {
  importFlowRpc,
  extractCreatedTemplateId,
  type FlowImportBundle,
  type ImportOptions,
} from "./import-rpc.js";

const HEX24 = /^[a-f0-9]{24}$/i;
let failures = 0;
function fail(msg: string) {
  console.error(`FAIL: ${msg}`);
  failures++;
}
function ok(msg: string) {
  console.log(`✓ ${msg}`);
}

const TEAM_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const SERVER = "https://stub.local";
const BASE_OPTS: ImportOptions = { jwt: "stub.jwt.token", serverBase: SERVER };

function makeBundle(): FlowImportBundle {
  // Two send-email steps, two placeholder templates, sentinels matched.
  const s1 = "__PLACEHOLDER_klA__";
  const s2 = "__PLACEHOLDER_klB__";
  return {
    automation: {
      name: "Welcome Series (smoke)",
      enabled: false,
      schemaType: "marketing_email",
      category: "marketing",
      steps: [
        {
          type: "send_email",
          id: "step-1",
          templateId: s1,
          emailAddressFieldName: "customerEmail",
          recipientNameFieldName: "customerFullName",
          nextId: "step-2",
        },
        {
          type: "send_email",
          id: "step-2",
          templateId: s2,
          emailAddressFieldName: "customerEmail",
          recipientNameFieldName: "customerFullName",
          nextId: "flow_end",
        },
      ],
    },
    warnings: [],
    placeholderTemplates: [
      {
        sentinelId: s1,
        klaviyoTemplateId: "klA",
        subject: "Welcome!",
        fromEmail: null,
        fromLabel: null,
        previewText: null,
        fullTemplate: { sections: [], name: "A" },
        templateWarnings: [],
      },
      {
        sentinelId: s2,
        klaviyoTemplateId: "klB",
        subject: "Day 3",
        fromEmail: null,
        fromLabel: null,
        previewText: null,
        fullTemplate: { sections: [], name: "B" },
        templateWarnings: [],
      },
    ],
  };
}

function randomObjectId(): string {
  let s = "";
  for (let i = 0; i < 24; i++) s += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  return s;
}

/**
 * Install a fake global.fetch. `templateResponder` lets each scenario decide
 * what createEmailTemplate returns. Captures the createAdvancedFlow payload.
 */
function installFetch(opts: {
  templateResponder: (input: any) => any;
}): { capturedFlow: () => any } {
  let capturedFlow: any = null;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  (globalThis as any).fetch = async (url: string, init?: any) => {
    const u = String(url);
    const parsed = init?.body ? JSON.parse(init.body) : {};
    if (u.endsWith("/team")) {
      // resolveTeamId reads `.team._id`.
      return json({ _id: "user-1", team: { _id: TEAM_ID } });
    }
    if (u.includes("/marketing-rpc/createEmailTemplate")) {
      return json({ output: opts.templateResponder(parsed.input) });
    }
    if (u.includes("/rpc/createAdvancedFlow")) {
      capturedFlow = parsed.input?.newFlow ?? null;
      return json({ output: { _id: randomObjectId(), id: randomObjectId() } });
    }
    throw new Error(`smoke fetch: unexpected URL ${u}`);
  };

  return { capturedFlow: () => capturedFlow };
}

async function positiveCase() {
  const { capturedFlow } = installFetch({
    // Happy path: full entity with a top-level hex `_id`, as current redoapp
    // createEmailTemplate returns.
    templateResponder: () => ({ _id: randomObjectId(), name: "created" }),
  });

  const res = await importFlowRpc(makeBundle(), BASE_OPTS);

  if (res.createdTemplateCount !== 2) {
    fail(`positive: expected createdTemplateCount=2, got ${res.createdTemplateCount}`);
  } else {
    ok(`positive: createdTemplateCount=2 (real ids captured)`);
  }

  const flow = capturedFlow();
  if (!flow) {
    fail("positive: createAdvancedFlow was never called");
    return;
  }
  const emailSteps = (flow.steps ?? []).filter((s: any) => s.type === "send_email");
  if (emailSteps.length !== 2) {
    fail(`positive: expected 2 send_email steps in posted flow, got ${emailSteps.length}`);
  }
  let allReal = true;
  for (const s of emailSteps) {
    if (typeof s.templateId !== "string" || s.templateId.startsWith("__PLACEHOLDER_")) {
      fail(`positive: step ${s.id} still has placeholder templateId "${s.templateId}"`);
      allReal = false;
    } else if (!HEX24.test(s.templateId)) {
      fail(`positive: step ${s.id} templateId "${s.templateId}" is not a 24-hex ObjectId`);
      allReal = false;
    }
  }
  if (allReal) ok("positive: every send_email step swapped to a real ObjectId, no __PLACEHOLDER_ survived");

  // Extra: assert the two steps got DISTINCT ids (each placeholder → its own template).
  const ids = emailSteps.map((s: any) => s.templateId);
  if (new Set(ids).size === ids.length) ok("positive: distinct template ids per step");
  else fail(`positive: expected distinct template ids, got ${JSON.stringify(ids)}`);
}

async function negativeCase() {
  let threw = false;
  let posted = false;
  const { capturedFlow } = installFetch({
    // BROKEN: 200 OK but no `_id`/`id` anywhere — the exact silent failure
    // that orphaned Jack Henry's emails.
    templateResponder: () => ({ name: "no-id-here", subject: "oops" }),
  });
  try {
    await importFlowRpc(makeBundle(), BASE_OPTS);
  } catch (e: any) {
    threw = true;
    const msg = String(e?.message ?? e);
    if (/no template _id|empty id|response shape/i.test(msg)) {
      ok(`negative: import threw loudly on empty id — "${msg.slice(0, 90)}…"`);
    } else {
      // Still threw (good), but the message should point at the id problem.
      fail(`negative: threw but message doesn't mention the missing id: "${msg}"`);
    }
  }
  posted = capturedFlow() != null;
  if (!threw) fail("negative: import did NOT throw on an empty template id (silent orphan!)");
  if (posted) fail("negative: createAdvancedFlow was POSTed despite the empty id");
  else ok("negative: createAdvancedFlow was never POSTed (failed before the orphaning POST)");
}

async function swapMismatchCase() {
  // A step references a sentinel that has NO matching placeholder (so the
  // sentinel→real map never gets a key for it). The id-capture throw can't
  // fire here — both placeholders create fine — so this exercises the
  // SWAP-level fail-loud (Fix 3) in isolation. Old code silently kept the
  // placeholder; new code must throw before createAdvancedFlow.
  const { capturedFlow } = installFetch({
    templateResponder: () => ({ _id: randomObjectId(), name: "created" }),
  });
  const bundle = makeBundle();
  // Add an orphan step whose sentinel is not in placeholderTemplates.
  bundle.automation.steps.push({
    type: "send_email",
    id: "step-orphan",
    templateId: "__PLACEHOLDER_unmatched__",
    emailAddressFieldName: "customerEmail",
    recipientNameFieldName: "customerFullName",
    nextId: "flow_end",
  });

  let threw = false;
  try {
    await importFlowRpc(bundle, BASE_OPTS);
  } catch (e: any) {
    threw = true;
    const msg = String(e?.message ?? e);
    if (/no resolved Redo template id|__PLACEHOLDER_unmatched__/i.test(msg)) {
      ok(`swap-mismatch: threw on unresolved sentinel — "${msg.slice(0, 90)}…"`);
    } else {
      fail(`swap-mismatch: threw but message doesn't identify the unresolved sentinel: "${msg}"`);
    }
  }
  if (!threw) fail("swap-mismatch: did NOT throw on an unresolved sentinel (silent orphan!)");
  if (capturedFlow() != null) fail("swap-mismatch: createAdvancedFlow was POSTed despite an unresolved sentinel");
  else ok("swap-mismatch: createAdvancedFlow was never POSTed");
}

function unitCase() {
  const good = randomObjectId();
  const cases: Array<[string, any, string]> = [
    ["top-level _id", { _id: good, name: "x" }, good],
    ["top-level id", { id: good }, good],
    ["nested template._id", { template: { _id: good } }, good],
    ["nested data._id", { data: { _id: good } }, good],
    ["empty object", {}, ""],
    ["null", null, ""],
    ["non-hex string id", { _id: "not-an-objectid" }, ""],
    ["object that stringifies to junk", { _id: { foo: 1 } }, ""],
  ];
  let allPass = true;
  for (const [label, input, expected] of cases) {
    const got = extractCreatedTemplateId(input);
    if (got !== expected) {
      fail(`unit: extractCreatedTemplateId(${label}) = "${got}", expected "${expected}"`);
      allPass = false;
    }
  }
  if (allPass) ok(`unit: extractCreatedTemplateId handles ${cases.length} shapes correctly`);
}

async function main() {
  unitCase();
  await positiveCase();
  await negativeCase();
  await swapMismatchCase();

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll flow-templateid-swap smoke assertions passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Pure-core checks for the post-import verifier. No network: the readback is
// handed in as fixtures shaped like getAdvancedFlows / getEmailTemplates.

import {
  scoreChecks,
  verifyFlow,
  type Check,
  type ExpectedFlow,
  type RedoTemplate,
} from "./verify-import.js";

let failed = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`✓ ${label}`);
  } else {
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function templates(...rows: RedoTemplate[]): Map<string, RedoTemplate> {
  return new Map(rows.map((r) => [r._id, r]));
}

const REAL = "6a7cb0b72f4a5f7cece7cdb1";
const BLANK = "6a7cb0b8d63af97afdef961c";
const EMPTY = "6a7cb0ba85cd38174c4ad0aa";
const TPLS = templates(
  { _id: REAL, name: "Welcome #1", sections: [{}, {}] },
  { _id: BLANK, name: "[Placeholder] Welcome #2", sections: [{}] },
  { _id: EMPTY, name: "Welcome #3", sections: [] },
);

const baseExpected = (steps: Array<Record<string, any>>): ExpectedFlow => ({
  name: "Welcome Series",
  steps,
  warnings: [],
});

const verdicts = (cs: Check[], item: string) =>
  cs.filter((c) => c.item.includes(item)).map((c) => c.verdict);

// 1. flow missing entirely
{
  const cs = verifyFlow(baseExpected([{ type: "trigger" }]), null, TPLS);
  check(
    "missing flow → single broken check",
    cs.length === 1 && cs[0].verdict === "broken",
    JSON.stringify(cs),
  );
}

// 2. happy path
{
  const exp = baseExpected([{ type: "trigger" }, { type: "send_email" }]);
  const act = { _id: "f1", steps: [{ type: "trigger" }, { type: "send_email", templateId: REAL }] };
  const cs = verifyFlow(exp, act, TPLS);
  const s = scoreChecks(cs);
  check("clean import → 100 / A", s.score === 100 && s.grade === "A", JSON.stringify(s));
  check("clean import → no broken", s.broken === 0);
}

// 3. the Bailey's failure: step exists, template is a blank placeholder
{
  const exp = baseExpected([{ type: "trigger" }, { type: "send_email" }]);
  const act = { _id: "f1", steps: [{ type: "trigger" }, { type: "send_email", templateId: BLANK }] };
  const cs = verifyFlow(exp, act, TPLS);
  check(
    "blank placeholder template → broken content",
    verdicts(cs, "send_email").join() === "broken",
    JSON.stringify(cs.map((c) => [c.item, c.verdict])),
  );
}

// 4. template exists but has zero sections
{
  const exp = baseExpected([{ type: "trigger" }, { type: "send_email" }]);
  const act = { _id: "f1", steps: [{ type: "trigger" }, { type: "send_email", templateId: EMPTY }] };
  const cs = verifyFlow(exp, act, TPLS);
  check("zero-section template → broken", verdicts(cs, "send_email").join() === "broken");
}

// 5. templateId that isn't in the store at all
{
  const exp = baseExpected([{ type: "trigger" }, { type: "send_email" }]);
  const act = {
    _id: "f1",
    steps: [{ type: "trigger" }, { type: "send_email", templateId: "6a7cb0bfffffffffffffffff" }],
  };
  check("unknown templateId → broken", verdicts(verifyFlow(exp, act, TPLS), "send_email").join() === "broken");
}

// 6. sentinel that survived the placeholder swap
{
  const exp = baseExpected([{ type: "trigger" }, { type: "send_email" }]);
  const act = {
    _id: "f1",
    steps: [{ type: "trigger" }, { type: "send_email", templateId: "__PLACEHOLDER_0__" }],
  };
  check("unswapped sentinel → broken", verdicts(verifyFlow(exp, act, TPLS), "send_email").join() === "broken");
}

// 7. SMS is unverified, and unverified stays out of the denominator
{
  const exp = baseExpected([{ type: "trigger" }, { type: "send_sms" }]);
  const act = { _id: "f1", steps: [{ type: "trigger" }, { type: "send_sms", templateId: REAL }] };
  const cs = verifyFlow(exp, act, TPLS);
  const s = scoreChecks(cs);
  check("send_sms → unverified", verdicts(cs, "send_sms").join() === "unverified");
  check(
    "unverified excluded from denominator",
    s.unverified === 1 && s.scored === 2 && s.score === 100,
    JSON.stringify(s),
  );
}

// 8. step graph drift
{
  const exp = baseExpected([{ type: "trigger" }, { type: "wait" }, { type: "send_email" }]);
  const act = { _id: "f1", steps: [{ type: "trigger" }, { type: "send_email", templateId: REAL }] };
  const cs = verifyFlow(exp, act, TPLS);
  check("dropped step → broken step graph", verdicts(cs, "step graph").join() === "broken");
}

// 9. trigger logic drift
{
  const exp = baseExpected([
    { type: "trigger", frequencyCap: { mode: "NO_REENTRY" }, shouldSkipSmartSending: true },
  ]);
  const act = { _id: "f1", steps: [{ type: "trigger", shouldSkipSmartSending: true }] };
  const cs = verifyFlow(exp, act, TPLS);
  check("lost frequencyCap → broken", verdicts(cs, "trigger.frequencyCap").join() === "broken");
  check(
    "matching shouldSkipSmartSending → clean",
    verdicts(cs, "trigger.shouldSkipSmartSending").join() === "clean",
  );
}

// 10. warnings: merchant-visible ones cost half an item, bookkeeping ones cost nothing
{
  const exp: ExpectedFlow = {
    name: "Welcome Series",
    steps: [{ type: "trigger" }],
    warnings: [
      { kind: "degraded-mapping", message: "wait has no clock time" },
      { kind: "gate", message: "routine" },
      { kind: "skip", message: "routine" },
    ],
  };
  const cs = verifyFlow(exp, { _id: "f1", steps: [{ type: "trigger" }] }, TPLS);
  const s = scoreChecks(cs);
  check("degraded-mapping → 1 degraded", s.degraded === 1, JSON.stringify(s));
  check("gate/skip warnings ignored", s.scored === 3, JSON.stringify(s));
  check("half credit for degraded", Math.round(s.score) === 83, String(s.score));
}

// 11. grade bands
{
  const band = (clean: number, broken: number) =>
    scoreChecks([
      ...Array.from({ length: clean }, (): Check => ({ item: "x", dimension: "content", verdict: "clean", detail: "" })),
      ...Array.from({ length: broken }, (): Check => ({ item: "y", dimension: "content", verdict: "broken", detail: "" })),
    ]).grade;
  check("19/20 → A", band(19, 1) === "A");
  check("9/10 → B", band(9, 1) === "B");
  check("3/4 → C", band(3, 1) === "C");
  check("1/2 → D", band(1, 1) === "D");
  check("1/4 → F", band(1, 3) === "F");
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall verify-import checks passed");

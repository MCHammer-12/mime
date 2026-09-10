/** Smoke test for the absolute-invariant QA checks.
 *
 *   npx tsx src/flow/qa-checks.smoke.ts
 */

import {
  deadBranchChecks,
  reachabilityChecks,
  activationChecks,
  triggerCollisionChecks,
  renderChecks,
} from "./qa-checks.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const trigger = (nextId: string, key = "email_signup") => ({ type: "trigger", id: "trigger", key, nextId });

// ─── An ab_test hands control off through variants[], not a top-level next ───
// The whole downstream chain reads as dead if the walk only looks at the top
// level — 22 live steps at Bailey's were reported unreachable that way.

const abTest = {
  _id: "f1",
  name: "split",
  steps: [
    trigger("split"),
    {
      type: "ab_test",
      id: "split",
      variants: [
        { id: "v1", weight: 50, nextId: "a" },
        { id: "v2", weight: 50, nextId: "b" },
      ],
    },
    { type: "send_email", id: "a" },
    { type: "send_email", id: "b" },
  ],
};
const abChecks = reachabilityChecks(abTest);
if (abChecks.length !== 0) fail(`ab_test variants: expected 0 checks, got ${abChecks.map((c) => c.item).join(", ")}`);
console.log("✓ reachability follows ab_test variant edges");

// ─── A genuinely orphaned step is still caught ───

const orphan = {
  _id: "f2",
  name: "orphan",
  steps: [trigger("a"), { type: "send_email", id: "a" }, { type: "send_email", id: "lost" }],
};
const orphanChecks = reachabilityChecks(orphan);
if (orphanChecks.length !== 1 || orphanChecks[0].verdict !== "broken") {
  fail(`orphan: expected 1 broken, got ${JSON.stringify(orphanChecks)}`);
}
console.log("✓ orphaned send step still flagged broken");

// ─── A pointer into nothing is broken ───

const dangling = { _id: "f3", name: "dangling", steps: [trigger("nowhere")] };
if (!reachabilityChecks(dangling).some((c) => c.detail.includes("not a step in this flow"))) {
  fail("dangling pointer not flagged");
}
console.log("✓ dangling pointer flagged");

// ─── Empty inline segment: the true branch is what dies ───

const dead = {
  _id: "f4",
  name: "dead",
  steps: [
    trigger("split"),
    {
      type: "condition",
      id: "split",
      expression: { dataSource: "inline-segment", inlineSegment: { mode: "AND", conditions: [] } },
      nextTrueId: "a",
      nextFalseId: "b",
    },
    { type: "send_email", id: "a" },
    { type: "do_nothing", id: "b" },
  ],
};
const deadChecks = deadBranchChecks(dead);
if (deadChecks.length !== 1 || deadChecks[0].verdict !== "broken") fail("empty inline segment not flagged");
if (!deadChecks[0].detail.includes("false path")) fail("dead-branch detail names the wrong branch");
console.log("✓ empty inline segment flagged, false path named");

// ─── Activation ───

if (activationChecks({ _id: "f5", name: "on", enabled: true }).length !== 1) fail("active flow not flagged");
if (activationChecks({ _id: "f5", name: "off", enabled: false }).length !== 0) fail("inactive flow flagged");
console.log("✓ activation check fires only on an active flow");

// ─── Collisions the migration is not a party to are not its findings ───

const a = { _id: "a", name: "theirs A", steps: [trigger("x", "order_created")] };
const b = { _id: "b", name: "theirs B", steps: [trigger("x", "order_created")] };
const mine = { _id: "m", name: "mine", steps: [trigger("x", "order_created")] };

if (triggerCollisionChecks([a, b], new Set(["m"])).length !== 0) {
  fail("pre-existing collision reported against a migration it does not involve");
}
if (triggerCollisionChecks([a, b, mine], new Set(["m"])).length !== 1) {
  fail("collision involving an in-scope flow not reported");
}
if (triggerCollisionChecks([a, b]).length !== 1) fail("unscoped collision should still report");
console.log("✓ collisions scoped to the migration");

// ─── Segment gates split a shared membership trigger ───
// customer_group_entered fires for every segment; a flow gated on one segment
// right after the trigger only sees that segment's events.

const gated = (id: string, segment: string) => ({
  _id: id,
  name: `gated ${id}`,
  steps: [
    trigger("gate", "customer_group_entered"),
    {
      type: "condition",
      id: "gate",
      expression: {
        dataSource: "trigger-data",
        schemaBooleanExpression: { type: "text_match", field: "segment", operator: "equals", matchValues: [segment] },
      },
      nextTrueId: "end",
      nextFalseId: "miss",
    },
  ],
});
const open = { _id: "o", name: "open", steps: [trigger("end", "customer_group_entered")] };

if (triggerCollisionChecks([gated("g1", "segA"), gated("g2", "segB")]).length !== 0) {
  fail("flows gated on different segments reported as colliding");
}
const same = triggerCollisionChecks([gated("g1", "segA"), gated("g2", "segA")]);
if (same.length !== 1 || !same[0].item.includes("segA")) fail("flows gated on the same segment not reported");
const mixed = triggerCollisionChecks([gated("g1", "segA"), open]);
if (mixed.length !== 1 || !mixed[0].detail.includes("ungated: open")) {
  fail("ungated flow next to a gated one not reported, or the ungated one not named");
}
console.log("✓ segment gates split a shared membership trigger");

// ─── Render checks ───

const good = {
  id: "t1",
  name: "Welcome",
  subject: "Welcome to the shop",
  html: `<p>${"Thanks for joining us, here is what happens next. ".repeat(3)}</p>
         <a href="https://example.com/unsubscribe">Unsubscribe</a>
         <img src="https://cdn.shopify.com/a.png">`,
};
if (renderChecks(good).some((c) => c.verdict !== "clean")) {
  fail(`clean template flagged: ${JSON.stringify(renderChecks(good))}`);
}
console.log("✓ a well-formed template renders clean");

const liquid = { ...good, html: good.html + "{{ organization.name }}" };
if (!renderChecks(liquid).some((c) => c.verdict === "broken")) fail("surviving Liquid not flagged");

const klaviyoAsset = { ...good, html: good.html + '<img src="https://d3k81ch9hvuctc.cloudfront.net/x.png">' };
if (!renderChecks(klaviyoAsset).some((c) => c.verdict === "degraded" && c.detail.includes("CDN"))) {
  fail("Klaviyo CDN asset not flagged");
}

const noUnsub = { ...good, html: "<p>" + "words ".repeat(20) + "</p>" };
if (!renderChecks(noUnsub).some((c) => c.detail.toLowerCase().includes("unsubscribe"))) {
  fail("missing unsubscribe not flagged");
}
if (renderChecks(noUnsub, { requireUnsubscribe: false }).some((c) => c.detail.toLowerCase().includes("unsubscribe"))) {
  fail("unsubscribe flagged when not required");
}
console.log("✓ render checks catch Liquid, Klaviyo assets, missing unsubscribe");

console.log("✓ qa-checks smoke tests pass");

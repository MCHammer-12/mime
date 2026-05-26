/**
 * Smoke test for substituteStringVars (used on subject lines + preview
 * text in flow-attached templates).
 *
 *   npx tsx src/transform.smoke.ts
 *
 * Locks in the post-2026-05-26 behavior: customer-profile variable
 * substitution preserves any Liquid filter on the source variable.
 * Without filter support, Klaviyo subjects like "Thank you
 * {{ first_name|default:'' }} :)" shipped to Redo with the raw
 * template variable intact, and the merchant saw it literal in
 * their email preview (Castle Sports Post Purchase Email 1).
 */
import { substituteStringVars } from "./transform.js";

const orgCtx = {
  orgName: "Castle Sports",
  orgAddress: "1 Castle St, Townsville",
  orgUrl: "https://castlesports.com",
};

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// ─── Bare {{ first_name }} → customer_first_name ────────────────────────
{
  const out = substituteStringVars("Hi {{ first_name }}!", orgCtx);
  assert(
    out === "Hi {{ customer_first_name }}!",
    `bare first_name rewritten, got: ${JSON.stringify(out)}`,
  );
}

// ─── {{ first_name|default:'' }} preserves filter — the Castle case ────
{
  const subs: string[] = [];
  const out = substituteStringVars(
    "Thank you {{ first_name|default:'' }} :)",
    orgCtx,
    subs,
  );
  assert(
    out.includes("customer_first_name") &&
      out.includes("|default:''") &&
      !out.includes("first_name|"),
    `filter preserved + var rewritten, got: ${JSON.stringify(out)}`,
  );
  assert(
    subs.some((s) => s.includes("first_name") && s.includes("customer_first_name")),
    `substitution noted in subs, got: ${JSON.stringify(subs)}`,
  );
}

// ─── {{ first_name|capitalize }} preserves a different filter ───────────
{
  const out = substituteStringVars("Hi {{ first_name|capitalize }}!", orgCtx);
  assert(
    out.includes("customer_first_name") && out.includes("|capitalize"),
    `non-default filter preserved, got: ${JSON.stringify(out)}`,
  );
}

// ─── {{ person.first_name }} also rewrites via dotted path ──────────────
{
  const out = substituteStringVars("Welcome, {{ person.first_name }}", orgCtx);
  assert(
    out === "Welcome, {{ customer_first_name }}",
    `person.first_name rewrites, got: ${JSON.stringify(out)}`,
  );
}

// ─── Unknown variable left unchanged (no map entry) ─────────────────────
{
  const out = substituteStringVars("Hi {{ unknown_var }}!", orgCtx);
  assert(
    out === "Hi {{ unknown_var }}!",
    `unknown var unchanged, got: ${JSON.stringify(out)}`,
  );
}

// ─── Unknown variable with filter also left unchanged ──────────────────
{
  const out = substituteStringVars("Hi {{ unknown_var|default:'' }}!", orgCtx);
  assert(
    out === "Hi {{ unknown_var|default:'' }}!",
    `unknown var w/ filter unchanged, got: ${JSON.stringify(out)}`,
  );
}

// ─── organization.name still substitutes (regression check) ─────────────
{
  const out = substituteStringVars("From {{ organization.name }}", orgCtx);
  assert(
    out === "From Castle Sports",
    `org.name still substitutes, got: ${JSON.stringify(out)}`,
  );
}

// ─── shop.name still substitutes (regression check) ─────────────────────
{
  const out = substituteStringVars("Visit {{ shop.name }}!", orgCtx);
  assert(
    out === "Visit Castle Sports!",
    `shop.name still substitutes, got: ${JSON.stringify(out)}`,
  );
}

// ─── Mixed: org + customer + filter, all together ──────────────────────
{
  const out = substituteStringVars(
    "Hi {{ first_name|default:'friend' }}, welcome to {{ organization.name }}",
    orgCtx,
  );
  assert(
    out.includes("customer_first_name") &&
      out.includes("|default:'friend'") &&
      out.includes("Castle Sports"),
    `mixed substitution, got: ${JSON.stringify(out)}`,
  );
}

console.log("transform.smoke.ts: all assertions passed");

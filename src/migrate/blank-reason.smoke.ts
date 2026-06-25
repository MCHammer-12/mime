/**
 * Smoke test for Task 10 — surface the resolve-failure reason for every blanked
 * flow email (Jack Henry, 2026-06-25). When a template resolves to null at parse
 * time, mime imports a BLANK template; this used to be silent
 * (`blankTemplateCount++` only). Now importFlowRpc returns `blankedTemplates`
 * (name + klaviyoTemplateId + typed reason) and emits a `template_blanked`
 * progress event.
 *
 *   npx tsx src/migrate/blank-reason.smoke.ts
 *
 * Hermetic — stubs global.fetch as the Redo server (no network).
 */
import { importFlowRpc, type FlowImportBundle, type ImportOptions } from "./import-rpc.js";

let failures = 0;
function fail(msg: string) { console.error(`FAIL: ${msg}`); failures++; }
function ok(msg: string) { console.log(`✓ ${msg}`); }

const TEAM_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const SERVER = "https://stub.local";

function randomObjectId(): string {
  let s = "";
  for (let i = 0; i < 24; i++) s += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  return s;
}

// Two emails: one resolved fine, one blanked at parse time (fullTemplate null,
// templateWarnings carries the typed resolver reason the parser recorded).
function makeBundle(): FlowImportBundle {
  const sOk = "__PLACEHOLDER_ok__";
  const sBlank = "__PLACEHOLDER_blank__";
  return {
    automation: {
      name: "WC | Abandoned Cart",
      enabled: false,
      schemaType: "marketing_cart_abandonment",
      category: "marketing",
      steps: [
        { type: "send_email", id: "s1", templateId: sOk, emailAddressFieldName: "customerEmail", recipientNameFieldName: "customerFullName", nextId: "s2" },
        { type: "send_email", id: "s2", templateId: sBlank, emailAddressFieldName: "customerEmail", recipientNameFieldName: "customerFullName", nextId: "flow_end" },
      ],
    },
    warnings: [],
    placeholderTemplates: [
      { sentinelId: sOk, klaviyoTemplateId: "klOK", subject: "Still in your cart", fromEmail: null, fromLabel: null, previewText: null, fullTemplate: { sections: [{ type: "text" }], name: "ok" }, templateWarnings: [] },
      { sentinelId: sBlank, klaviyoTemplateId: "klBAD", subject: "Come back", fromEmail: null, fromLabel: null, previewText: null, fullTemplate: null, templateWarnings: ["Resolver failed (api-error): Klaviyo 500 fetching template klBAD"] },
    ],
  };
}

function installFetch() {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  (globalThis as any).fetch = async (url: string, init?: any) => {
    const u = String(url);
    const parsed = init?.body ? JSON.parse(init.body) : {};
    if (u.endsWith("/team")) return json({ _id: "user-1", team: { _id: TEAM_ID } });
    if (u.includes("/marketing-rpc/createEmailTemplate")) return json({ output: { _id: randomObjectId() } });
    if (u.includes("/rpc/createAdvancedFlow")) return json({ output: { _id: randomObjectId() } });
    throw new Error(`smoke fetch: unexpected URL ${u}`);
  };
}

async function main() {
  installFetch();
  const events: any[] = [];
  const opts: ImportOptions = { jwt: "stub.jwt", serverBase: SERVER, onProgress: (e) => events.push(e) };
  const r = await importFlowRpc(makeBundle(), opts);

  if (r.createdTemplateCount !== 1) fail(`expected 1 created, got ${r.createdTemplateCount}`);
  if (r.blankTemplateCount !== 1) fail(`expected 1 blank, got ${r.blankTemplateCount}`);

  const blanked = r.blankedTemplates ?? [];
  if (blanked.length !== 1) fail(`expected 1 blankedTemplates entry, got ${blanked.length}`);
  else {
    const b = blanked[0]!;
    if (b.klaviyoTemplateId !== "klBAD") fail(`blanked entry wrong klaviyo id: ${b.klaviyoTemplateId}`);
    if (!/api-error/.test(b.reason)) fail(`blanked reason should carry the typed resolver reason, got: ${b.reason}`);
    if (!/Come back/.test(b.name)) fail(`blanked name should include the subject, got: ${b.name}`);
    else ok(`blankedTemplates surfaces the api-error reason for the blanked email (${b.reason.slice(0, 50)}…)`);
  }
  // the resolved email is NOT reported as blank
  if (blanked.some((b) => b.klaviyoTemplateId === "klOK")) fail("the resolved email must not appear in blankedTemplates");
  else ok("the resolved email is not falsely reported blank");

  const blankedEvents = events.filter((e) => e.kind === "template_blanked");
  if (blankedEvents.length !== 1) fail(`expected 1 template_blanked progress event, got ${blankedEvents.length}`);
  else if (!/api-error/.test(blankedEvents[0].reason)) fail("progress event missing the reason");
  else ok("template_blanked progress event emitted with the reason");

  if (failures > 0) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nAll blank-reason smoke checks passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });

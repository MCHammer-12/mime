// One-shot: fetch a single Klaviyo flow by id, parse it (with treeify),
// and import it into a Redo store via the RPC importer.
//
// Usage:
//   KLAVIYO_API_KEY=... REDO_JWT=... FLOW_ID=VeffyL npx tsx src/flow/import-one.ts

import dns from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";
import { fetchAllMetrics } from "../extract-metrics.js";

// Node's global fetch (undici) uses the OS resolver for DNS, which does NOT
// special-case `.localhost` (RFC 6761) the way curl does. Local redoapp dev
// uses hostnames like `merchant-server.getredo.localhost`. The lookup hook
// below forces any *.localhost hostname to 127.0.0.1 and delegates everything
// else to the real resolver.
{
  const url = process.env.REDO_SERVER_BASE ?? "";
  if (/\.localhost(?:[:/]|$)/.test(url)) {
    setGlobalDispatcher(
      new Agent({
        connect: {
          rejectUnauthorized: false, // local dev certs are self-signed
          lookup: (hostname: string, opts: any, cb: any) => {
            if (/\.localhost$/.test(hostname) || hostname === "localhost") {
              // undici may pass { all: true } (then cb expects an array of
              // {address, family}) or { all: false } (single address + family).
              if (opts?.all) {
                cb(null, [{ address: "127.0.0.1", family: 4 }]);
              } else {
                cb(null, "127.0.0.1", 4);
              }
              return;
            }
            dns.lookup(hostname, opts, cb);
          },
        },
      }),
    );
  }
}
import { fetchAccount } from "../fetch-account.js";
import { klaviyo } from "../klaviyo.js";
import { MARKETING_TRIGGER_OPTIONS } from "./marketing-trigger-options.js";
import { parseFlow } from "./parser.js";
import { createTemplateResolver } from "./template-resolver.js";
import {
  importFlowRpc,
  uploadFontsForTemplates,
  type ImportProgressEvent,
} from "../migrate/import-rpc.js";
import { SchemaType, StepType, type KlaviyoFlow } from "./types.js";
import { findVacuousConditions } from "./vacuous-conditions.js";
import { assertUpToDate } from "../git-freshness.js";
import { recordRun } from "./run-ledger.js";
import { formatReport, verifyImportedFlow } from "./verify-import.js";

async function main() {
  assertUpToDate();

  const klaviyoKey = process.env.KLAVIYO_API_KEY;
  const redoJwt = process.env.REDO_JWT;
  const flowId = process.env.FLOW_ID;
  const skipAi = process.env.SKIP_AI === "1" || !process.env.ANTHROPIC_API_KEY;

  const diagnoseOnly = process.env.DIAGNOSE_ONLY === "1";

  if (!klaviyoKey) throw new Error("KLAVIYO_API_KEY not set");
  if (!redoJwt && !diagnoseOnly) throw new Error("REDO_JWT not set");
  if (!flowId) throw new Error("FLOW_ID not set");

  // Optional: force a specific Redo trigger instead of auto-resolving from the
  // Klaviyo flow — this is how you "duplicate a flow with a different trigger".
  // FORCE_TRIGGER is a MARKETING_TRIGGER_OPTIONS value (e.g. email_signup_shopify).
  // NAME_SUFFIX is appended to the flow name so the duplicate is distinguishable.
  const forceTrigger = process.env.FORCE_TRIGGER;
  const nameSuffix = process.env.NAME_SUFFIX;
  let forcedTrigger = undefined as (typeof MARKETING_TRIGGER_OPTIONS)[number]["resolution"] | undefined;
  if (forceTrigger) {
    const opt = MARKETING_TRIGGER_OPTIONS.find((o) => o.value === forceTrigger);
    if (!opt) {
      throw new Error(
        `FORCE_TRIGGER="${forceTrigger}" not found. Options: ${MARKETING_TRIGGER_OPTIONS.map((o) => o.value).join(", ")}`,
      );
    }
    forcedTrigger = opt.resolution;
    console.log(`      forcing trigger: ${opt.label} (${opt.resolution.schemaType})`);
    // Redo matches the custom event name exactly, and its ingested names rarely
    // equal Klaviyo's metric name (Okendo sends "Okendo Loyalty Points Redeemed"
    // to Klaviyo but okendo_loyalty_points_redeemed to Redo). Without this the
    // parser falls back to the Klaviyo name and the flow silently never fires.
    // Read the team's real names from marketing-rpc/getCustomEventNames.
    const eventName = process.env.EVENT_NAME;
    if (eventName) {
      forcedTrigger = { ...forcedTrigger, eventName };
      console.log(`      event name: ${eventName}`);
    }
  }

  console.log(`[1/5] fetching metrics...`);
  const metrics = await fetchAllMetrics(klaviyoKey);
  console.log(`      ${Object.keys(metrics).length} metrics`);

  console.log(`[2/5] fetching flow ${flowId}...`);
  const detail = await klaviyo(
    `/flows/${flowId}/?additional-fields%5Bflow%5D=definition`,
    klaviyoKey,
  );
  const flow = detail as KlaviyoFlow;
  console.log(`      "${flow.data.attributes.name}" [${flow.data.attributes.status}]`);
  const actionCount = flow.data.attributes.definition?.actions?.length ?? 0;
  console.log(`      ${actionCount} actions`);

  console.log(`[3/5] fetching Klaviyo account...`);
  let account = null;
  try {
    account = await fetchAccount(klaviyoKey);
    console.log(`      ${account.organizationName}`);
  } catch (e: any) {
    console.warn(`      skipped (${e.message})`);
  }

  console.log(`[4/5] parsing + treeifying flow...`);
  const templateResolver = createTemplateResolver({
    merchantDir: "/tmp/mime-import-one", // no manifest — API-only mode
    account,
    skipAi,
    klaviyoApiKey: klaviyoKey,
  });

  // Decode the JWT aud claim locally so we can show the store ID pre-import.
  const audTeamId = redoJwt ? decodeJwtAud(redoJwt) : null;
  if (audTeamId) console.log(`      target store: ${audTeamId}`);

  const parsed = await parseFlow(flow, metrics, {
    teamId: audTeamId ?? "__TEAM_ID__",
    templateResolver,
    account,
    forcedTrigger,
  });
  if (parsed.automation && nameSuffix) {
    parsed.automation.name = `${parsed.automation.name}${nameSuffix}`;
    console.log(`      renamed → "${parsed.automation.name}"`);
  }

  if (!parsed.automation) {
    console.error(`parse failed: ${parsed.skipped?.reason ?? "unknown reason"}`);
    for (const w of parsed.warnings) {
      console.error(`  WARNING ${w.kind}: ${w.message}`);
    }
    process.exit(1);
  }

  console.log(`      parsed ${parsed.automation.steps.length} steps, ${parsed.placeholderTemplates.length} template(s)`);

  // A Klaviyo segment trigger names the segment it watches; Redo's
  // marketing_segment_membership_change fires on *every* segment. Without a
  // gate right after the trigger the flow sends to anyone entering any
  // segment. Pin it to the Redo segment that mirrors the Klaviyo one.
  const segmentId = process.env.SEGMENT_ID;
  if (segmentId) {
    if (parsed.automation.schemaType !== SchemaType.MARKETING_SEGMENT_MEMBERSHIP_CHANGE) {
      console.error(
        `SEGMENT_ID is only meaningful for a segment-membership trigger; this flow is ${parsed.automation.schemaType}`,
      );
      process.exit(1);
    }
    const trigger = parsed.automation.steps.find((s) => s.type === StepType.TRIGGER);
    if (!trigger || !("nextId" in trigger) || !trigger.nextId) {
      console.error(`SEGMENT_ID set but the parsed flow has no trigger to gate`);
      process.exit(1);
    }
    const gateId = `segment_gate`;
    const missId = `segment_gate_miss`;
    parsed.automation.steps.push(
      {
        type: StepType.CONDITION,
        id: gateId,
        expression: {
          dataSource: "trigger-data",
          schemaBooleanExpression: {
            type: "text_match",
            field: "segment",
            operator: "equals",
            matchValues: [segmentId],
          },
        },
        nextTrueId: trigger.nextId,
        nextFalseId: missId,
      },
      { type: StepType.DO_NOTHING, id: missId },
    );
    trigger.nextId = gateId;
    console.log(`      gated on segment ${segmentId}`);
  }

  // Dump the parsed automation to disk for offline inspection + diagnostics.
  const dumpPath = `/tmp/mime-parsed-flow-${flowId}.json`;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(dumpPath, JSON.stringify(parsed.automation, null, 2), "utf8");
  console.log(`      (dumped to ${dumpPath})`);

  // Placeholder templates carry the rewritten email/SMS bodies — the payloads
  // createEmailTemplate/createSmsTemplate reject when a Liquid token survives
  // the rewrite. They're not part of `automation`, so dump them alongside it.
  const tplDumpPath = `/tmp/mime-parsed-templates-${flowId}.json`;
  writeFileSync(
    tplDumpPath,
    JSON.stringify(
      { email: parsed.placeholderTemplates, sms: parsed.placeholderSmsTemplates },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`      (templates dumped to ${tplDumpPath})`);

  for (const w of parsed.warnings) {
    console.log(`      ${w.kind}: ${w.message}${w.actionId ? ` (action ${w.actionId})` : ""}`);
  }

  // Count step-id duplication evidence (treeify markers)
  const dupSteps = parsed.automation.steps.filter((s) => s.id.includes("__dup_"));
  if (dupSteps.length > 0) {
    console.log(`      treeify: ${dupSteps.length} duplicated step(s) (merge branches expanded)`);
  } else {
    console.log(`      treeify: no merges detected`);
  }

  // An inline-segment condition with no conditions matches everyone, so the
  // branch silently always takes the true path. See vacuous-conditions.ts.
  const vacuous = findVacuousConditions(parsed.automation.steps);
  for (const v of vacuous) {
    console.log(
      `      vacuous condition: step ${v.id} matches everyone — always takes true ` +
        `(${v.nextTrueId}); false branch (${v.falseBranchType} ${v.nextFalseId}) never runs`,
    );
  }

  // Stop before the import call — the diagnosis above is the whole output.
  if (diagnoseOnly) {
    console.log(`\nDIAGNOSE_ONLY=1 — stopping before import.`);
    return;
  }

  if (vacuous.length > 0 && !process.env.ALLOW_VACUOUS_CONDITIONS) {
    console.error(
      `\nRefusing to import: ${vacuous.length} condition step(s) carry no translatable ` +
        `filter, so Redo would match every customer and silently take the true branch. ` +
        `Resolve the filter (see the warnings above) or re-run with ` +
        `ALLOW_VACUOUS_CONDITIONS=1 to import as-is.`,
    );
    process.exit(1);
  }

  console.log(`[5/5] importing into Redo...`);
  const onProgress = (e: ImportProgressEvent) => {
    switch (e.kind) {
      case "template_created":
        console.log(`      ✓ template "${e.templateName}" → ${e.templateId}`);
        break;
      case "template_failed":
        console.log(`      ✗ template "${e.templateName}": ${e.error}`);
        break;
      case "flow_started":
        console.log(`      flow import starting (${e.placeholderCount} placeholder(s))`);
        break;
      case "flow_created":
        console.log(`      ✓ flow "${e.flowName}" → ${e.flowId}`);
        break;
      case "flow_failed":
        console.log(`      ✗ flow failed: ${e.error}`);
        break;
      case "font_uploading":
        console.log(`      uploading font ${e.family}/${e.fileName}`);
        break;
      case "font_registered":
        console.log(`      ✓ font family ${e.family}`);
        break;
      case "fonts_done":
        console.log(`      fonts: ${e.uploaded} uploaded, ${e.skipped} skipped`);
        break;
    }
  };

  const options = {
    // Non-null past this point: the DIAGNOSE_ONLY return above is the only
    // path that reaches here without a JWT.
    jwt: redoJwt as string,
    serverBase: process.env.REDO_SERVER_BASE,
    account,
    onProgress,
  };

  // Upload fonts first (idempotent — merges into existing brand kit). Non-fatal:
  // if updateBrandKit fails (e.g. team has an empty/partial brand kit), we log
  // and continue — the flow + templates still import; fonts can be relinked
  // manually in the builder.
  const templatesForFonts = parsed.placeholderTemplates
    .map((p) => p.fullTemplate)
    .filter((t): t is NonNullable<typeof t> => t !== null);
  try {
    const fontResult = await uploadFontsForTemplates(templatesForFonts, options);
    if (fontResult.unresolved.length > 0) {
      console.log(`      unresolved fonts:`);
      for (const u of fontResult.unresolved) {
        console.log(`        - ${u.family} (${u.reason}) used by: ${u.usedBy.join(", ")}`);
      }
    }
  } catch (e: any) {
    console.warn(`      font upload failed (non-fatal): ${e.message ?? e}`);
    if (e.cause) console.warn(`        cause: ${e.cause.message ?? e.cause}`);
  }

  const ledgerBase = {
    teamId: audTeamId ?? "unknown",
    klaviyoFlowId: flowId,
    flowName: flow.data.attributes.name,
  };

  let result;
  try {
    result = await importFlowRpc(
      {
        automation: parsed.automation,
        warnings: parsed.warnings,
        placeholderTemplates: parsed.placeholderTemplates,
        placeholderSmsTemplates: parsed.placeholderSmsTemplates,
      },
      options,
    );
  } catch (e: any) {
    console.error(`\nimport failed: ${e.message ?? e}`);
    recordRun({ ...ledgerBase, redoFlowId: null, status: "failed", blankCount: 0 });
    process.exit(1);
  }

  console.log(`\ndone.`);
  console.log(`  flow id:               ${result.flowId}`);
  console.log(`  templates created:     ${result.createdTemplateCount}`);
  console.log(`  blank placeholders:    ${result.blankTemplateCount}`);

  recordRun({
    ...ledgerBase,
    flowName: result.name,
    redoFlowId: result.flowId,
    status: result.blankTemplateCount > 0 ? "blanks" : "clean",
    blankCount: result.blankTemplateCount,
  });

  // Read the flow back out of Redo and diff it against the parse. The import
  // log reports what we SENT; this reports what LANDED — the only view that
  // matches what the merchant will open.
  let readbackBroken = 0;
  try {
    const { checks, score } = await verifyImportedFlow(
      result.flowId,
      {
        name: result.name,
        steps: parsed.automation.steps as Array<Record<string, any>>,
        warnings: parsed.warnings as Array<{ kind: string; message: string }>,
      },
      options,
    );
    console.log(formatReport(checks, score));
    readbackBroken = score.broken;
  } catch (e: any) {
    // A readback that can't reach the API says nothing about the import.
    console.warn(`\nreadback skipped (non-fatal): ${e.message ?? e}`);
  }

  // A blank email is a merchant-visible failure that reads as success: the flow
  // is live and wired to an empty template. Exiting 0 here is what let 15 of
  // them sit in Bailey's Blossoms unnoticed. Make the run say it failed.
  if (result.blankTemplateCount > 0) {
    console.error(
      `\nBLANKS: ${result.blankTemplateCount} email(s) imported with no content.`,
    );
    for (const b of result.blankedTemplates ?? []) {
      console.error(`  - ${b.name}`);
      console.error(`      ${b.reason}`);
    }
    console.error(
      `\nThe flow exists, but those emails are empty in Redo. Fix the cause, then:\n` +
        `  FLOW_ID=${flowId} npx tsx src/flow/import-one.ts`,
    );
    process.exit(1);
  }

  // The import reported success but the store disagrees. Same reasoning as
  // blanks: a run that lands broken must not exit 0.
  if (readbackBroken > 0) {
    console.error(
      `\nREADBACK: ${readbackBroken} item(s) did not land correctly. See BROKEN above.`,
    );
    process.exit(1);
  }
}

function decodeJwtAud(jwt: string): string | null {
  try {
    const [, payload] = jwt.split(".");
    if (!payload) return null;
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    const aud = json.aud as string | undefined;
    if (!aud) return null;
    return aud.startsWith("mcht/") ? aud.slice("mcht/".length) : aud;
  } catch {
    return null;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

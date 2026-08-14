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

async function main() {
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

  // Stop before the import call — the diagnosis above is the whole output.
  if (diagnoseOnly) {
    console.log(`\nDIAGNOSE_ONLY=1 — stopping before import.`);
    return;
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

  try {
    const result = await importFlowRpc(
      {
        automation: parsed.automation,
        warnings: parsed.warnings,
        placeholderTemplates: parsed.placeholderTemplates,
        placeholderSmsTemplates: parsed.placeholderSmsTemplates,
      },
      options,
    );
    console.log(`\ndone.`);
    console.log(`  flow id:               ${result.flowId}`);
    console.log(`  templates created:     ${result.createdTemplateCount}`);
    console.log(`  blank placeholders:    ${result.blankTemplateCount}`);
  } catch (e: any) {
    console.error(`\nimport failed: ${e.message ?? e}`);
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

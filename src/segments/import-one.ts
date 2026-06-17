// One-shot: fetch a single Klaviyo segment, translate it, verify the Redo
// population against Klaviyo's, and (unless diagnosing) create the Redo segment.
//
// Usage:
//   KLAVIYO_API_KEY=... REDO_JWT=... SEGMENT_ID=abc123 npx tsx src/segments/import-one.ts
//
// Optional env:
//   SEGMENT_FILE=path.json   read a saved detail instead of fetching by id
//   MERCHANT_AOV=85          AOV seed for CLV→order-count (auto-tuned anyway)
//   TOLERANCE=0.10           count-match gate (default 0.10)
//   AUTO_TUNE=0              disable threshold auto-tuning
//   DIAGNOSE_ONLY=1          translate + verify, never create
//   LIST_TO_SEGMENT='{"L1":"redoSegId"}'  Klaviyo list→Redo segment map
//   REDO_SERVER_BASE=...     defaults to https://app-server.getredo.com

import dns from "node:dns";
import { readFileSync } from "node:fs";
import { Agent, setGlobalDispatcher } from "undici";
import { fetchAllMetrics } from "../extract-metrics.js";
import { klaviyo } from "../klaviyo.js";
import { decodeJwtAud } from "../migrate/import-rpc.js";
import { createDynamicSegment } from "./redo-client.js";
import { translateSegment } from "./translate.js";
import { verifySegment } from "./verify.js";

// Local redoapp dev uses *.localhost hostnames undici's resolver won't special-
// case. Mirror src/flow/import-one.ts.
{
  const url = process.env.REDO_SERVER_BASE ?? "";
  if (/\.localhost(?:[:/]|$)/.test(url)) {
    setGlobalDispatcher(
      new Agent({
        connect: {
          rejectUnauthorized: false,
          lookup: (hostname: string, opts: any, cb: any) => {
            if (/\.localhost$/.test(hostname) || hostname === "localhost") {
              if (opts?.all) cb(null, [{ address: "127.0.0.1", family: 4 }]);
              else cb(null, "127.0.0.1", 4);
              return;
            }
            dns.lookup(hostname, opts, cb);
          },
        },
      }),
    );
  }
}

async function main() {
  const key = process.env.KLAVIYO_API_KEY;
  const jwt = process.env.REDO_JWT;
  const segmentId = process.env.SEGMENT_ID;
  const segmentFile = process.env.SEGMENT_FILE;
  const diagnoseOnly = process.env.DIAGNOSE_ONLY === "1";
  const aov = process.env.MERCHANT_AOV ? Number(process.env.MERCHANT_AOV) : undefined;
  const tolerance = process.env.TOLERANCE ? Number(process.env.TOLERANCE) : 0.1;
  const autoTune = process.env.AUTO_TUNE !== "0";
  const listToSegment = process.env.LIST_TO_SEGMENT
    ? (JSON.parse(process.env.LIST_TO_SEGMENT) as Record<string, string>)
    : undefined;

  if (!key) throw new Error("KLAVIYO_API_KEY not set");
  if (!segmentId && !segmentFile) throw new Error("set SEGMENT_ID or SEGMENT_FILE");
  if (!jwt && !diagnoseOnly) throw new Error("REDO_JWT not set (or set DIAGNOSE_ONLY=1)");

  console.log(`[1/4] fetching metrics…`);
  const metrics = await fetchAllMetrics(key);
  console.log(`      ${Object.keys(metrics).length} metrics`);

  console.log(`[2/4] loading segment…`);
  const detail = segmentFile
    ? JSON.parse(readFileSync(segmentFile, "utf8"))
    : await klaviyo(
        `/segments/${segmentId}/?additional-fields%5Bsegment%5D=definition,profile_count`,
        key,
      );
  const attrs = detail.data?.attributes ?? {};
  const segment = {
    id: detail.data?.id ?? segmentId ?? "unknown",
    name: attrs.name ?? null,
    definition: attrs.definition ?? null,
    profileCount: attrs.profile_count ?? null,
  };
  console.log(`      "${segment.name}" — Klaviyo profiles: ${segment.profileCount ?? "?"}`);

  console.log(`[3/4] translating…`);
  const t = translateSegment(segment, { metrics, aov, listToSegment });
  const blocks = t.query.conditionBlocks.length;
  const conds = t.query.conditionBlocks.reduce((n, b) => n + b.conditions.length, 0);
  console.log(`      ${blocks} block(s), ${conds} condition(s) — ${t.importable ? "importable" : "NOT importable"}${t.partial ? " (partial)" : ""}`);
  for (const s of t.substitutions) {
    console.log(`      ~ substitute: ${s.klaviyoSummary}  →  ${s.redoLogic}`);
  }
  for (const d of t.dropped) {
    console.log(`      ✗ dropped: ${d.klaviyoType}${d.dimension ? ` [${d.dimension}]` : ""} — ${d.reason}`);
  }

  if (!t.importable) {
    console.log(`\nnothing to import — every condition was unsupported.`);
    return;
  }

  if (diagnoseOnly && !jwt) {
    console.log(`\nDIAGNOSE_ONLY + no JWT — skipping count verification + create.`);
    console.log(JSON.stringify(t.query, null, 2));
    return;
  }

  console.log(`[4/4] verifying population against Klaviyo…`);
  const v = await verifySegment(t, { jwt: jwt!, serverBase: process.env.REDO_SERVER_BASE, tolerance, autoTune });
  if (v.tuned.length) {
    for (const tn of v.tuned) console.log(`      tuned: ${tn.summary} (${tn.from} → ${tn.to})`);
  }
  const pct = v.deltaPct == null ? "n/a" : `${(v.deltaPct * 100).toFixed(1)}%`;
  console.log(`      Klaviyo: ${v.klaviyoCount ?? "?"}   Redo: ${v.redoCount}   Δ ${pct}   (${v.probes} probe${v.probes === 1 ? "" : "s"})`);
  console.log(`      email-eligible ${v.counts.emailEligibleCount} · email-subs ${v.counts.emailSubscriberCount} · sms-subs ${v.counts.smsSubscriberCount}`);

  if (v.withinTolerance === false) {
    console.log(`      ⚠ outside ±${(tolerance * 100).toFixed(0)}% — the substitution doesn't reproduce Klaviyo's population.`);
  } else if (v.withinTolerance === true) {
    console.log(`      ✓ within ±${(tolerance * 100).toFixed(0)}%`);
  } else {
    console.log(`      (no Klaviyo count to compare against)`);
  }

  if (diagnoseOnly) {
    console.log(`\nDIAGNOSE_ONLY=1 — not creating.`);
    return;
  }
  if (v.withinTolerance === false && process.env.FORCE !== "1") {
    console.log(`\nrefusing to create (outside tolerance). Re-run with FORCE=1 to import anyway, or adjust MERCHANT_AOV.`);
    return;
  }

  const created = await createDynamicSegment(t.name, t.query, { jwt: jwt!, serverBase: process.env.REDO_SERVER_BASE });
  console.log(`\n✓ created Redo segment "${created.name}" → ${created.id}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

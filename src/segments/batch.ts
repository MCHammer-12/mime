// Offline coverage report over an extracted segment corpus. No Redo calls —
// pure translation, so you can see how much of an account migrates cleanly
// before touching a store.
//
// Usage:
//   KLAVIYO_API_KEY=... MERCHANT=<name> npx tsx src/segments/batch.ts
//   (KLAVIYO_API_KEY only needed to resolve profile-metric ids → names)

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchAllMetrics, type MetricLookup } from "../extract-metrics.js";
import { translateSegment } from "./translate.js";

async function main() {
  const merchant = process.env.MERCHANT ?? "unknown";
  const dir = join("migrations", merchant, "segments");
  const aov = process.env.MERCHANT_AOV ? Number(process.env.MERCHANT_AOV) : undefined;

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    throw new Error(`no segment corpus at ${dir} — run extract-segments.ts first`);
  }

  let metrics: MetricLookup = {};
  if (process.env.KLAVIYO_API_KEY) {
    metrics = await fetchAllMetrics(process.env.KLAVIYO_API_KEY);
  } else {
    console.warn("(no KLAVIYO_API_KEY — profile-metric conditions will be dropped as unknown)\n");
  }

  let importable = 0,
    partial = 0,
    notImportable = 0;
  let exactConds = 0,
    subConds = 0,
    droppedConds = 0;
  const dropReasons = new Map<string, number>();

  for (const f of files.sort()) {
    const detail = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const attrs = detail.data?.attributes ?? {};
    const t = translateSegment(
      {
        id: detail.data?.id ?? f,
        name: attrs.name ?? null,
        definition: attrs.definition ?? null,
        profileCount: attrs.profile_count ?? null,
      },
      { metrics, aov },
    );

    const conds = t.query.conditionBlocks.reduce((n, b) => n + b.conditions.length, 0);
    exactConds += conds - t.substitutions.length;
    subConds += t.substitutions.length;
    droppedConds += t.dropped.length;
    for (const d of t.dropped) {
      const k = `${d.klaviyoType}${d.dimension ? `[${d.dimension}]` : ""}`;
      dropReasons.set(k, (dropReasons.get(k) ?? 0) + 1);
    }

    const status = !t.importable ? "DROP" : t.partial ? "PART" : "OK  ";
    if (!t.importable) notImportable++;
    else if (t.partial) partial++;
    else importable++;

    const subNote = t.substitutions.length ? ` ~${t.substitutions.length}` : "";
    const dropNote = t.dropped.length ? ` ✗${t.dropped.length}` : "";
    console.log(`  [${status}] ${t.name}${subNote}${dropNote}`);
  }

  console.log(`\n— ${files.length} segments —`);
  console.log(`  clean importable: ${importable}`);
  console.log(`  partial (some conditions dropped): ${partial}`);
  console.log(`  not importable (all conditions unsupported): ${notImportable}`);
  console.log(`\n  conditions: ${exactConds} exact, ${subConds} substituted, ${droppedConds} dropped`);
  if (dropReasons.size) {
    console.log(`\n  dropped condition types:`);
    for (const [k, n] of [...dropReasons.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${n}×  ${k}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

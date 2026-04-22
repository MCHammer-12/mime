import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { klaviyo, paginate } from "./klaviyo.js";

export interface KlaviyoMetric {
  id: string;
  name: string;
  integration_name: string | null;
  integration_category: string | null;
  integration_key: string | null;
  created: string | null;
}

/**
 * Per-account map: `{ metric_id → canonical name }`. Klaviyo metric IDs are
 * account-scoped; name is the stable key we use when mapping to Redo triggers.
 */
export type MetricLookup = Record<string, KlaviyoMetric>;

export async function fetchAllMetrics(key: string): Promise<MetricLookup> {
  const raw = await paginate("/metrics/", key);
  const out: MetricLookup = {};
  for (const m of raw as any[]) {
    const a = m.attributes ?? {};
    const integ = a.integration ?? {};
    out[m.id] = {
      id: m.id,
      name: a.name ?? "",
      integration_name: integ.name ?? null,
      integration_category: integ.category ?? null,
      integration_key: integ.key ?? null,
      created: a.created ?? null,
    };
  }
  return out;
}

async function main() {
  const key = process.env.KLAVIYO_API_KEY;
  const merchant = process.env.MERCHANT ?? "unknown";
  if (!key) throw new Error("KLAVIYO_API_KEY not set");

  console.log(`fetching metrics for merchant=${merchant}...`);
  const metrics = await fetchAllMetrics(key);
  const count = Object.keys(metrics).length;

  const outDir = join("migrations", merchant);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "metrics.json"), JSON.stringify(metrics, null, 2));

  console.log(`wrote ${count} metrics to ${outDir}/metrics.json`);

  const byIntegration: Record<string, number> = {};
  for (const m of Object.values(metrics)) {
    const k = m.integration_name ?? "(none)";
    byIntegration[k] = (byIntegration[k] ?? 0) + 1;
  }
  for (const [k, v] of Object.entries(byIntegration).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v.toString().padStart(4)} ${k}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

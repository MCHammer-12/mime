import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFlow } from "./flow/parser.js";
import { createTemplateResolver } from "./flow/template-resolver.js";
import type { KlaviyoFlow } from "./flow/types.js";
import type { MetricLookup } from "./extract-metrics.js";
import { fetchAccount } from "./fetch-account.js";

async function loadMetrics(merchant: string): Promise<MetricLookup> {
  const p = join("migrations", merchant, "metrics.json");
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch (e) {
    throw new Error(
      `no metrics.json at ${p} — run: KLAVIYO_API_KEY=... MERCHANT=${merchant} npx tsx src/extract-metrics.ts`,
    );
  }
}

async function main() {
  const merchant = process.env.MERCHANT;
  const teamId = process.env.TEAM_ID ?? "__TEAM_ID__";
  const apiKey = process.env.KLAVIYO_API_KEY;
  const skipAi =
    process.env.SKIP_AI === "1" ||
    !(process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY);
  if (!merchant) throw new Error("MERCHANT not set");

  const metrics = await loadMetrics(merchant);
  const flowsDir = join("migrations", merchant, "flows");
  const outDir = join("migrations", merchant, "automations");
  await mkdir(outDir, { recursive: true });

  // Fetch Klaviyo account for `{{ organization.* }}` substitution inside
  // email templates. Optional — if the API key isn't set or the call fails,
  // templates still parse; just leave those variables unresolved.
  let account = null;
  if (apiKey) {
    try {
      account = await fetchAccount(apiKey);
    } catch (e: any) {
      console.warn(`  Warning: fetchAccount failed (${e.message}). Continuing without org substitution.`);
    }
  }

  // Resolver inlines real email content into send-email steps. If the
  // merchant hasn't run extract-templates.ts, this is null and the parser
  // emits blank placeholders (same as before).
  const templateResolver = createTemplateResolver({
    merchantDir: join("migrations", merchant),
    account,
    skipAi,
    // Klaviyo API key enables fallback fetches for flow-embedded templates
    // that aren't returned by /templates/ (so don't appear in the manifest).
    klaviyoApiKey: apiKey ?? null,
  });
  if (!templateResolver) {
    console.warn(
      `  Warning: no templates-manifest.json in migrations/${merchant}/ and no KLAVIYO_API_KEY — send-email steps will use blank placeholders.`,
    );
  }

  const files = (await readdir(flowsDir)).filter((f) => f.endsWith(".json"));

  const summary: any[] = [];
  let ok = 0;
  let skipped = 0;
  for (const f of files) {
    const flow: KlaviyoFlow = JSON.parse(await readFile(join(flowsDir, f), "utf8"));
    const result = await parseFlow(flow, metrics, { teamId, templateResolver, account });
    const slug = f.replace(/\.json$/, "");

    if (result.automation) {
      await writeFile(
        join(outDir, `${slug}.json`),
        JSON.stringify(
          {
            automation: result.automation,
            warnings: result.warnings,
            placeholderTemplates: result.placeholderTemplates,
          },
          null,
          2,
        ),
      );
      ok++;
    } else {
      skipped++;
    }

    const warningKinds: Record<string, number> = {};
    for (const w of result.warnings) {
      warningKinds[w.kind] = (warningKinds[w.kind] ?? 0) + 1;
    }

    const resolvedTemplates = result.placeholderTemplates.filter((p) => p.fullTemplate).length;
    summary.push({
      id: flow.data.id,
      name: flow.data.attributes.name,
      status: flow.data.attributes.status,
      enabled: result.automation?.enabled ?? false,
      trigger: (result.automation?.steps?.[0] as any)?.key ?? null,
      schemaType: result.automation?.schemaType ?? null,
      stepCount: result.automation?.steps.length ?? 0,
      placeholderTemplateCount: result.placeholderTemplates.length,
      resolvedTemplateCount: resolvedTemplates,
      warningKinds,
      skipped: !result.automation,
      skipReason: result.skipped?.reason ?? null,
    });
  }

  await writeFile(
    join("migrations", merchant, "automations-manifest.json"),
    JSON.stringify({ merchant, generated_at: new Date().toISOString(), ok, skipped, flows: summary }, null, 2),
  );

  console.log(`parsed ${ok}/${files.length} flows (${skipped} skipped)`);
  console.log(`wrote ${outDir}/*.json + automations-manifest.json`);

  const warningCounts: Record<string, number> = {};
  for (const s of summary) {
    for (const [k, v] of Object.entries(s.warningKinds)) {
      warningCounts[k] = (warningCounts[k] ?? 0) + (v as number);
    }
  }
  if (Object.keys(warningCounts).length) {
    console.log("\nwarnings by kind:");
    for (const [k, v] of Object.entries(warningCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(v).padStart(4)} ${k}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

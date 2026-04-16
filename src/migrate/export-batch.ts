/**
 * Batch-export all Klaviyo templates in a migration directory to Redo
 * EmailTemplate JSON, ready for import via import-klaviyo-templates.ts.
 *
 * Usage:
 *   KLAVIYO_API_KEY=pk_... npx tsx src/migrate/export-batch.ts <templates-dir>
 *
 * Flags:
 *   --skip-ai     Skip AI inline-coupon rewrites even if an Anthropic key is set.
 *   --force       Re-export templates that already have a .redo-template.json.
 *
 * Example:
 *   KLAVIYO_API_KEY=pk_8b99... npx tsx src/migrate/export-batch.ts \
 *     ../../migrations/merchant-2/templates
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { argv, env } from "node:process";
import { fetchAccount } from "../fetch-account.js";
import { exportTemplate } from "../export-template.js";

const args = argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = argv.slice(2).filter((a) => a.startsWith("--"));

const templatesDir = args[0];
if (!templatesDir) {
  console.error("Usage: npx tsx src/migrate/export-batch.ts <templates-dir> [--skip-ai] [--force]");
  process.exit(1);
}

const skipAiFlag = flags.includes("--skip-ai");
const force = flags.includes("--force");

const skipAi =
  skipAiFlag ||
  env.SKIP_AI === "1" ||
  !(env.AI_INTEGRATIONS_ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY);

const resolvedDir = resolve(templatesDir);
if (!existsSync(resolvedDir)) {
  console.error(`Directory not found: ${resolvedDir}`);
  process.exit(1);
}

const htmlFiles = readdirSync(resolvedDir)
  .filter((f) => f.endsWith(".html"))
  .sort();

if (htmlFiles.length === 0) {
  console.error(`No .html files found in ${resolvedDir}`);
  process.exit(1);
}

async function main() {
  const apiKey = env.KLAVIYO_API_KEY;
  if (!apiKey) {
    console.warn("KLAVIYO_API_KEY not set — variable substitution will be skipped.");
  }
  if (skipAi) {
    console.warn("AI disabled (SKIP_AI or no Anthropic key) — inline-coupon rewrites skipped.");
  }

  // Fetch account once for the whole batch
  let account = null;
  if (apiKey) {
    try {
      account = await fetchAccount(apiKey);
      console.log(`Account: ${account.organizationName}`);
    } catch (e: any) {
      console.warn(`fetchAccount failed (${e.message}) — substitution skipped.`);
    }
  }

  console.log(`\nExporting ${htmlFiles.length} templates from ${resolvedDir}\n`);

  let success = 0;
  let skipped = 0;
  let failed = 0;
  const failures: { file: string; error: string }[] = [];

  // Track totals across batch
  let totalAiRewrites = 0;
  let totalWarnings = 0;
  let totalUnsupported = 0;
  let totalReviewItems = 0;

  for (const file of htmlFiles) {
    const htmlPath = join(resolvedDir, file);
    const outPath = htmlPath.replace(/\.html$/, ".redo-template.json");

    if (!force && existsSync(outPath)) {
      console.log(`  [skip] ${file} (already exported)`);
      skipped++;
      continue;
    }

    process.stdout.write(`  ${file} … `);
    try {
      const result = await exportTemplate(htmlPath, { account, skipAi });

      const flags: string[] = [];
      if (result.warnings.length > 0) flags.push(`${result.warnings.length}w`);
      if (result.unsupportedFeatures.length > 0) flags.push(`${result.unsupportedFeatures.length}u`);
      if (result.reviewItems.length > 0) flags.push(`${result.reviewItems.length}r`);
      if (result.aiRewrites > 0) flags.push(`${result.aiRewrites}ai`);
      if (result.fontPlan.hasUnresolved) flags.push("font!");

      console.log(`ok (${result.sectionCount}s)${flags.length > 0 ? " [" + flags.join(" ") + "]" : ""}`);

      totalAiRewrites += result.aiRewrites;
      totalWarnings += result.warnings.length;
      totalUnsupported += result.unsupportedFeatures.length;
      totalReviewItems += result.reviewItems.length;
      success++;
    } catch (e: any) {
      const msg = e.message || String(e);
      console.log(`FAILED: ${msg}`);
      failures.push({ file, error: msg });
      failed++;
    }
  }

  console.log(`\nDone: ${success} exported, ${skipped} skipped, ${failed} failed`);
  if (totalWarnings > 0) console.log(`  Total parser warnings: ${totalWarnings}`);
  if (totalUnsupported > 0) console.log(`  Total unsupported features: ${totalUnsupported}`);
  if (totalReviewItems > 0) console.log(`  Total review items: ${totalReviewItems}`);
  if (totalAiRewrites > 0) console.log(`  Total AI coupon rewrites: ${totalAiRewrites}`);

  if (failures.length > 0) {
    console.log(`\nFailed templates:`);
    for (const f of failures) console.log(`  - ${f.file}: ${f.error}`);
    process.exit(1);
  }

  if (success > 0) {
    console.log(`\nNext: run the import-klaviyo-templates manage script from redoapp:`);
    console.log(`  bazel run //redo/manage:import-klaviyo-templates -- \\`);
    console.log(`    --team <store-id> \\`);
    const accountDir = resolvedDir.split("/").slice(-2)[0];
    console.log(`    --account ${accountDir} \\`);
    console.log(`    --mime-dir ~/code/redo/mime`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

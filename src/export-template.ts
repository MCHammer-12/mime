/**
 * Export a Klaviyo template as a complete Redo EmailTemplate JSON object.
 *
 * This produces the exact same structure that lives in Redo's MongoDB —
 * ready to show to the eng team or POST to the Redo API.
 *
 * Usage:
 *   KLAVIYO_API_KEY=pk_... npx tsx src/export-template.ts <template.html> [template.json]
 *
 * The optional .json arg is the Klaviyo API response (for name, subject, etc.)
 * If omitted, defaults are used.
 *
 * KLAVIYO_API_KEY enables account-level variable substitution (org name,
 * address, unsubscribe link, website URL). Without it, variables stay as-is.
 */

import { readFileSync, writeFileSync } from "fs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ObjectId } from "bson";
import { parseKlaviyoHtml } from "./parser/index.js";
import { fetchAccount, type KlaviyoAccount } from "./fetch-account.js";
import { transformSections } from "./transform.js";
import { buildFontPlan } from "./fonts.js";

export interface ExportResult {
  outPath: string;
  name: string;
  sectionCount: number;
  substitutions: string[];
  aiRewrites: number;
  aiUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
  warnings: string[];
  unsupportedFeatures: { blockType: string; reason: string; context: string }[];
  reviewItems: { blockType: string; variableName: string; context: string }[];
  skippedBlocks: { blockType: string; reason: string }[];
  fontPlan: Awaited<ReturnType<typeof buildFontPlan>>;
}

/**
 * Core per-template export. Pass a pre-fetched `account` (or null to skip
 * variable substitution). `skipAi` suppresses the inline-coupon LLM call.
 */
export async function exportTemplate(
  htmlPath: string,
  opts: { account: KlaviyoAccount | null; skipAi: boolean },
): Promise<ExportResult> {
  const html = readFileSync(htmlPath, "utf-8");
  const {
    sections: rawSections,
    warnings,
    unsupportedFeatures,
    reviewItems,
    skippedBlocks,
    bodyBackgroundColor,
  } = parseKlaviyoHtml(html);

  // Infer metadata from a sibling .json file if present
  const jsonPath = htmlPath.replace(/\.html$/, ".json");
  let klaviyoMeta: { name?: string; subject?: string; created?: string } = {};
  if (existsSync(jsonPath)) {
    const raw = JSON.parse(readFileSync(jsonPath, "utf-8"));
    klaviyoMeta = {
      name: raw.attributes?.name || raw.name,
      subject: raw.attributes?.name || raw.name,
      created: raw.attributes?.created,
    };
  }

  let sections = rawSections;
  let substitutions: string[] = [];
  let aiRewrites = 0;
  let aiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

  if (opts.account) {
    const result = await transformSections(rawSections, opts.account, { skipAi: opts.skipAi });
    sections = result.sections;
    substitutions = result.substitutions;
    aiRewrites = result.aiRewrites;
    aiUsage = result.aiUsage;
  }

  const fontPlan = await buildFontPlan(sections);

  const name =
    klaviyoMeta.name ||
    htmlPath.split("/").pop()?.replace(".html", "") ||
    "Imported Template";

  // If the template references the `checkoutUrl` schema field (via image
  // clickthrough or button link), it's an abandoned-checkout flow email.
  // Set schemaType so Redo can resolve the dynamic variable.
  const schemaType = referencesCheckoutUrl(sections)
    ? "marketing_checkout_abandonment"
    : "marketing_email";

  const emailTemplate = {
    _id: new ObjectId().toString(),
    name,
    subject: klaviyoMeta.subject || "",
    templateType: "marketing",
    category: "Marketing",
    schemaType,
    emailPreview: null,
    emailBackgroundColor: bodyBackgroundColor,
    contentBackgroundColor: "#ffffff",
    address: {
      businessAddress: "Business Name",
      legalAddress: "123 Main St",
      cityStateZip: "City, ST 12345",
      country: "United States",
    },
    sections,
    linkColor: "#0000ee",
    team: null,
    createdAt: klaviyoMeta.created || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isPlainText: false,
    _fontPlan: fontPlan,
  };

  const outPath = htmlPath.replace(/\.html$/, ".redo-template.json");
  writeFileSync(outPath, JSON.stringify(emailTemplate, null, 2));

  return {
    outPath,
    name,
    sectionCount: sections.length,
    substitutions,
    aiRewrites,
    aiUsage,
    warnings,
    unsupportedFeatures,
    reviewItems,
    skippedBlocks,
    fontPlan,
  };
}

/**
 * Walk top-level sections (and any nested column cells) to detect whether
 * any block references Redo's `checkoutUrl` schema field. Used to decide
 * whether this template should be emitted as `marketing_checkout_abandonment`.
 */
function referencesCheckoutUrl(sections: unknown[]): boolean {
  for (const section of sections) {
    if (!section || typeof section !== "object") continue;
    const s = section as {
      clickthroughSchemaFieldName?: string;
      schemaFieldName?: string;
      columns?: unknown[];
    };
    if (
      s.clickthroughSchemaFieldName === "checkoutUrl" ||
      s.schemaFieldName === "checkoutUrl"
    ) {
      return true;
    }
    if (Array.isArray(s.columns) && referencesCheckoutUrl(s.columns)) {
      return true;
    }
  }
  return false;
}

function printResult(r: ExportResult, verbose: boolean) {
  console.log(`  Name: ${r.name}`);
  console.log(`  Sections: ${r.sectionCount}`);
  if (r.substitutions.length > 0) {
    console.log(`  Substitutions: ${r.substitutions.length}`);
    if (verbose) for (const s of r.substitutions) console.log(`    - ${s}`);
  }
  if (r.aiRewrites > 0) {
    console.log(`  AI rewrites: ${r.aiRewrites} (in:${r.aiUsage.inputTokens} out:${r.aiUsage.outputTokens} cache-r:${r.aiUsage.cacheReadTokens})`);
  }
  if (r.warnings.length > 0) {
    console.log(`  Warnings: ${r.warnings.length}`);
    if (verbose) for (const w of r.warnings) console.log(`    - ${w}`);
  }
  if (r.unsupportedFeatures.length > 0) {
    console.log(`  Unsupported: ${r.unsupportedFeatures.length}`);
    if (verbose) for (const u of r.unsupportedFeatures) console.log(`    - [${u.blockType}] ${u.reason}`);
  }
  if (r.reviewItems.length > 0) {
    console.log(`  Review items: ${r.reviewItems.length}`);
    if (verbose) for (const ri of r.reviewItems) console.log(`    - [${ri.blockType}] ${ri.variableName}`);
  }
  if (r.skippedBlocks.length > 0) {
    console.log(`  Skipped: ${r.skippedBlocks.length}`);
    if (verbose) for (const s of r.skippedBlocks) console.log(`    - [${s.blockType}] ${s.reason}`);
  }
  if (r.fontPlan.entries.length > 0) {
    const unresolved = r.fontPlan.entries.filter((e) => !e.resolution.available);
    console.log(`  Fonts: ${r.fontPlan.entries.length}${unresolved.length > 0 ? ` (${unresolved.length} UNRESOLVED)` : ""}`);
  }
}

async function main() {
  const htmlPath = process.argv[2];

  if (!htmlPath) {
    console.error(
      "Usage: KLAVIYO_API_KEY=pk_... npx tsx src/export-template.ts <template.html>",
    );
    process.exit(1);
  }

  const apiKey = process.env.KLAVIYO_API_KEY;
  const skipAi =
    process.env.SKIP_AI === "1" ||
    !(process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY);

  if (!apiKey) console.warn("  Warning: KLAVIYO_API_KEY not set. Skipping variable substitution.");
  if (skipAi) console.warn("  Warning: AI skipped (SKIP_AI=1 or no Anthropic key).");

  let account = null;
  if (apiKey) {
    try {
      account = await fetchAccount(apiKey);
    } catch (e: any) {
      console.warn(`  Warning: fetchAccount failed (${e.message}). Skipping substitution.`);
    }
  }

  const result = await exportTemplate(htmlPath, { account, skipAi });
  console.log(`Exported: ${result.outPath}`);
  printResult(result, true);

  const typeCounts: Record<string, number> = {};
  // section types aren't on ExportResult directly — re-read the json
  const written = JSON.parse(readFileSync(result.outPath, "utf-8"));
  for (const s of written.sections ?? []) {
    typeCounts[s.type] = (typeCounts[s.type] || 0) + 1;
  }
  console.log("\n  Section breakdown:");
  for (const [type, count] of Object.entries(typeCounts)) {
    console.log(`    ${type}: ${count}`);
  }
}

// Only run CLI when invoked directly, not when imported as a module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

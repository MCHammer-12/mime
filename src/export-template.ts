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
import { ObjectId } from "bson";
import { parseKlaviyoHtml } from "./parser/index.js";
import { fetchAccount } from "./fetch-account.js";
import { transformSections } from "./transform.js";
import { buildFontPlan } from "./fonts.js";

async function main() {
  const htmlPath = process.argv[2];
  const jsonPath = process.argv[3];

  if (!htmlPath) {
    console.error(
      "Usage: KLAVIYO_API_KEY=pk_... npx tsx src/export-template.ts <template.html> [template-api.json]",
    );
    process.exit(1);
  }

  // Parse the HTML
  const html = readFileSync(htmlPath, "utf-8");
  const {
    sections: rawSections,
    warnings,
    unsupportedFeatures,
    reviewItems,
    skippedBlocks,
    bodyBackgroundColor,
  } = parseKlaviyoHtml(html);

  // Read optional Klaviyo API JSON for metadata
  let klaviyoMeta: { name?: string; subject?: string; created?: string } = {};
  if (jsonPath) {
    const raw = JSON.parse(readFileSync(jsonPath, "utf-8"));
    klaviyoMeta = {
      name: raw.attributes?.name || raw.name,
      subject: raw.attributes?.name || raw.name,
      created: raw.attributes?.created,
    };
  }

  // Post-parse variable substitution + AI inline-coupon rewrite
  const apiKey = process.env.KLAVIYO_API_KEY;
  const skipAi =
    process.env.SKIP_AI === "1" ||
    !(
      process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_API_KEY
    );
  let sections = rawSections;
  let substitutions: string[] = [];
  let aiRewrites = 0;
  let aiUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  if (apiKey) {
    try {
      const account = await fetchAccount(apiKey);
      const result = await transformSections(rawSections, account, {
        skipAi,
      });
      sections = result.sections;
      substitutions = result.substitutions;
      aiRewrites = result.aiRewrites;
      aiUsage = result.aiUsage;
    } catch (e: any) {
      console.warn(
        `  Warning: transform failed (${e.message}). Output may be partial.`,
      );
    }
  } else {
    console.warn("  Warning: KLAVIYO_API_KEY not set. Skipping variable substitution.");
  }
  if (skipAi) {
    console.warn(
      "  Warning: AI skipped (SKIP_AI=1 or no Anthropic key). Skipping inline-coupon rewrite.",
    );
  }

  // Font plan: collect custom fonts across all blocks, resolve via Google
  // Fonts. Attached as non-prod `_fontPlan` for the importer to consume
  // (auto-register resolvable fonts; block on unresolved).
  const fontPlan = await buildFontPlan(sections);

  // Build the complete EmailTemplate object
  const emailTemplate = {
    _id: new ObjectId().toString(),
    name: klaviyoMeta.name || htmlPath.split("/").pop()?.replace(".html", "") || "Imported Template",
    subject: klaviyoMeta.subject || "",
    templateType: "marketing",
    category: "Marketing",
    schemaType: "marketing_email",
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

  // Write output
  const outPath = htmlPath.replace(/\.html$/, ".redo-template.json");
  writeFileSync(outPath, JSON.stringify(emailTemplate, null, 2));

  console.log(`Exported Redo EmailTemplate: ${outPath}`);
  console.log(`  Name: ${emailTemplate.name}`);
  console.log(`  Sections: ${emailTemplate.sections.length}`);
  console.log(`  Background: ${emailTemplate.emailBackgroundColor}`);

  if (substitutions.length > 0) {
    console.log(`  Substitutions: ${substitutions.length}`);
    for (const s of substitutions) console.log(`    - ${s}`);
  }

  if (aiRewrites > 0) {
    console.log(`  AI inline-coupon rewrites: ${aiRewrites}`);
    console.log(
      `    tokens — input: ${aiUsage.inputTokens}, output: ${aiUsage.outputTokens}, cache read: ${aiUsage.cacheReadTokens}, cache write: ${aiUsage.cacheCreationTokens}`,
    );
  }

  if (warnings.length > 0) {
    console.log(`  Warnings: ${warnings.length}`);
    for (const w of warnings) console.log(`    - ${w}`);
  }

  if (unsupportedFeatures.length > 0) {
    console.log(`  Unsupported (blocks template): ${unsupportedFeatures.length}`);
    for (const u of unsupportedFeatures)
      console.log(`    - [${u.blockType}] ${u.reason} → ${u.context}`);
  }

  if (reviewItems.length > 0) {
    console.log(`  Review items: ${reviewItems.length}`);
    for (const r of reviewItems)
      console.log(`    - [${r.blockType}] ${r.variableName} → ${r.context}`);
  }

  if (skippedBlocks.length > 0) {
    console.log(`  Skipped blocks: ${skippedBlocks.length}`);
    for (const s of skippedBlocks)
      console.log(`    - [${s.blockType}] ${s.reason}`);
  }

  if (fontPlan.entries.length > 0) {
    console.log(`  Fonts: ${fontPlan.entries.length}${fontPlan.hasUnresolved ? " (unresolved present — importer will block)" : ""}`);
    for (const e of fontPlan.entries) {
      const status = e.resolution.available
        ? `${e.resolution.files.length} files`
        : `UNRESOLVED: ${e.resolution.reason}`;
      console.log(`    - ${e.family} [${e.usedBy.join(", ")}] → ${status}`);
    }
  }

  console.log(`\n  Section breakdown:`);
  const typeCounts: Record<string, number> = {};
  for (const s of emailTemplate.sections) {
    typeCounts[s.type] = (typeCounts[s.type] || 0) + 1;
  }
  for (const [type, count] of Object.entries(typeCounts)) {
    console.log(`    ${type}: ${count}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

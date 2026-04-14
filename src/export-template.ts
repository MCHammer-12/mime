/**
 * Export a Klaviyo template as a complete Redo EmailTemplate JSON object.
 *
 * This produces the exact same structure that lives in Redo's MongoDB —
 * ready to show to the eng team or POST to the Redo API.
 *
 * Usage:
 *   npx tsx src/export-template.ts <template.html> [template.json]
 *
 * The optional .json arg is the Klaviyo API response (for name, subject, etc.)
 * If omitted, defaults are used.
 */

import { readFileSync, writeFileSync } from "fs";
import { ObjectId } from "bson";
import { parseKlaviyoHtml } from "./parser/index.js";

const htmlPath = process.argv[2];
const jsonPath = process.argv[3];

if (!htmlPath) {
  console.error(
    "Usage: npx tsx src/export-template.ts <template.html> [template-api.json]",
  );
  process.exit(1);
}

// Parse the HTML
const html = readFileSync(htmlPath, "utf-8");
const {
  sections,
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
    subject: raw.attributes?.name || raw.name, // Klaviyo doesn't have a separate subject in template API
    created: raw.attributes?.created,
  };
}

// Stamp blockIds (production uses MongoDB ObjectIds)
const sectionsWithIds = sections.map((s) => ({
  ...s,
  blockId: new ObjectId().toString(),
}));

// Build the complete EmailTemplate object — same shape as Redo's MongoDB document
const emailTemplate = {
  _id: new ObjectId().toString(),
  name: klaviyoMeta.name || htmlPath.split("/").pop()?.replace(".html", "") || "Imported Template",
  subject: klaviyoMeta.subject || "",
  templateType: "marketing",
  category: "Marketing",
  schemaType: "marketing-email",
  emailPreview: null,
  emailBackgroundColor: bodyBackgroundColor,
  contentBackgroundColor: "#ffffff",
  address: {
    businessAddress: "Business Name",
    legalAddress: "123 Main St",
    cityStateZip: "City, ST 12345",
    country: "United States",
  },
  sections: sectionsWithIds,
  linkColor: "#0000ee",
  team: null, // Set to actual teamId when importing
  createdAt: klaviyoMeta.created || new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  isPlainText: false,
};

// Write output
const outPath = htmlPath.replace(/\.html$/, ".redo-template.json");
writeFileSync(outPath, JSON.stringify(emailTemplate, null, 2));

console.log(`Exported Redo EmailTemplate: ${outPath}`);
console.log(`  Name: ${emailTemplate.name}`);
console.log(`  Sections: ${emailTemplate.sections.length}`);
console.log(`  Background: ${emailTemplate.emailBackgroundColor}`);

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

// Also print a summary of the sections for quick review
console.log(`\n  Section breakdown:`);
const typeCounts: Record<string, number> = {};
for (const s of emailTemplate.sections) {
  typeCounts[s.type] = (typeCounts[s.type] || 0) + 1;
}
for (const [type, count] of Object.entries(typeCounts)) {
  console.log(`    ${type}: ${count}`);
}

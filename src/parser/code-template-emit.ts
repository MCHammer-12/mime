/**
 * Parse a CODE template and emit the Section[] JSON next to the HTML.
 *
 *   npx tsx src/parser/code-template-emit.ts <template.html>
 */
import { readFileSync, writeFileSync } from "fs";
import { parseCodeTemplateHtml } from "./code-template.js";

const htmlPath = process.argv[2];
if (!htmlPath) {
  console.error("Usage: npx tsx src/parser/code-template-emit.ts <template.html>");
  process.exit(1);
}

const html = readFileSync(htmlPath, "utf-8");
const { sections, bodyBackgroundColor, warnings } = parseCodeTemplateHtml(html);

const outPath = htmlPath.replace(/\.html$/, ".code-sections.json");
writeFileSync(
  outPath,
  JSON.stringify(
    { sections, bodyBackgroundColor, warnings },
    null,
    2,
  ),
);
console.log(`Wrote ${sections.length} sections → ${outPath}`);
if (warnings.length > 0) {
  console.log(`Warnings: ${warnings.length}`);
  for (const w of warnings) console.log(`  - ${w}`);
}

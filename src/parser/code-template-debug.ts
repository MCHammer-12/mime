/**
 * Debug: for each CODE template, print section count + whether a container
 * warning fired, so we can see how the fallback path performs.
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { parseCodeTemplateHtml } from "./code-template.js";

const dir = process.argv[2];
const manifestPath = join(dir, "..", "templates-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
const codeTemplates = manifest.templates.filter(
  (t: any) => t.editor_type === "CODE",
);

let noContainerCount = 0;
let noContainerWithFewSections = 0;
const noContainerLowSectionSamples: string[] = [];

for (const t of codeTemplates) {
  const f = t.files.html;
  if (!existsSync(f)) continue;
  const html = readFileSync(f, "utf-8");
  const { sections, warnings } = parseCodeTemplateHtml(html);
  const hadContainerWarn = warnings.some((w) =>
    w.includes("could not locate"),
  );
  if (hadContainerWarn) {
    noContainerCount++;
    if (sections.length < 3) {
      noContainerWithFewSections++;
      if (noContainerLowSectionSamples.length < 5) {
        noContainerLowSectionSamples.push(
          `${f} (${sections.length} sections, ${t.html_bytes} bytes)`,
        );
      }
    }
  }
}

console.log(`CODE templates: ${codeTemplates.length}`);
console.log(`No-container warning: ${noContainerCount}`);
console.log(`Of those, <3 sections (likely broken output): ${noContainerWithFewSections}`);
for (const s of noContainerLowSectionSamples) console.log(`  ${s}`);

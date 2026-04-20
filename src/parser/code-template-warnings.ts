/**
 * Dump all warnings from the CODE-template parser across the corpus.
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { parseCodeTemplateHtml } from "./code-template.js";

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: npx tsx src/parser/code-template-warnings.ts <dir>");
  process.exit(1);
}

const manifestPath = join(dir, "..", "templates-manifest.json");
let codeOnly: Set<string> | null = null;
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  codeOnly = new Set();
  for (const t of manifest.templates || []) {
    if (t.editor_type === "CODE" && t.files?.html) {
      codeOnly.add(t.files.html.replace(/^migrations\/[^/]+\//, ""));
    }
  }
}

const warningCounts = new Map<string, number>();
const warningSamples = new Map<string, string[]>();

for (const f of readdirSync(dir).filter((x) => x.endsWith(".html"))) {
  if (codeOnly && !codeOnly.has(`templates/${f}`)) continue;
  const html = readFileSync(join(dir, f), "utf-8");
  const { warnings } = parseCodeTemplateHtml(html);
  for (const w of warnings) {
    // Strip the variable text suffix so similar warnings group.
    const key = w.replace(/".*?"/, '"..."').replace(/\d+/g, "N");
    warningCounts.set(key, (warningCounts.get(key) || 0) + 1);
    const samples = warningSamples.get(key) || [];
    if (samples.length < 3) {
      samples.push(`${f}: ${w}`);
      warningSamples.set(key, samples);
    }
  }
}

const sorted = [...warningCounts.entries()].sort((a, b) => b[1] - a[1]);
for (const [key, count] of sorted) {
  console.log(`\n[${count}] ${key}`);
  for (const s of warningSamples.get(key) || []) console.log(`    ${s}`);
}

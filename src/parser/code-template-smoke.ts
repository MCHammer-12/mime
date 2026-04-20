/**
 * Smoke-test the CODE-template parser against a single file or a directory.
 * Prints parsed sections and any warnings. No AI / no substitution.
 *
 * Usage:
 *   npx tsx src/parser/code-template-smoke.ts <path.html>
 *   npx tsx src/parser/code-template-smoke.ts <dir>     # batch mode
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import { parseCodeTemplateHtml } from "./code-template.js";

function summarize(path: string) {
  const html = readFileSync(path, "utf-8");
  const { sections, warnings } = parseCodeTemplateHtml(html);
  const typeCounts: Record<string, number> = {};
  for (const s of sections) {
    typeCounts[s.type] = (typeCounts[s.type] || 0) + 1;
  }
  return { path, sectionCount: sections.length, typeCounts, warnings, sections };
}

function isHtml(f: string) {
  return f.endsWith(".html");
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: npx tsx src/parser/code-template-smoke.ts <path>");
    process.exit(1);
  }

  if (existsSync(arg) && statSync(arg).isFile()) {
    const r = summarize(arg);
    console.log(`File: ${r.path}`);
    console.log(`Sections: ${r.sectionCount}`);
    console.log(`Types: ${JSON.stringify(r.typeCounts)}`);
    if (r.warnings.length > 0) {
      console.log(`Warnings: ${r.warnings.length}`);
      for (const w of r.warnings) console.log(`  - ${w}`);
    }
    console.log("\n--- Sections ---");
    console.log(JSON.stringify(r.sections, null, 2));
    return;
  }

  // Batch mode. If a template-manifest.json sits next to the dir, filter to
  // only editor_type: CODE templates (so we're not over-counting successes
  // on block-editor templates that should go through the Klaviyo parser).
  const manifestPath = join(arg, "..", "templates-manifest.json");
  let codeOnly: Set<string> | null = null;
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    codeOnly = new Set();
    for (const t of manifest.templates || []) {
      if (t.editor_type === "CODE" && t.files?.html) {
        codeOnly.add(t.files.html.replace(/^migrations\/[^/]+\//, ""));
      }
    }
    console.log(`Filtering to ${codeOnly.size} CODE templates via manifest`);
  }
  const files = readdirSync(arg)
    .filter(isHtml)
    .filter((f) => {
      if (!codeOnly) return true;
      // Manifest paths are like "migrations/otishi/templates/<file>.html"
      return codeOnly.has(`templates/${f}`);
    })
    .map((f) => join(arg, f));
  let totalSections = 0;
  let emptyCount = 0;
  let failureCount = 0;
  let warningCount = 0;
  const typeTotals: Record<string, number> = {};
  const failures: { path: string; error: string }[] = [];
  const empties: string[] = [];

  for (const f of files) {
    try {
      const r = summarize(f);
      totalSections += r.sectionCount;
      warningCount += r.warnings.length;
      if (r.sectionCount === 0) {
        emptyCount++;
        empties.push(f);
      }
      for (const [t, c] of Object.entries(r.typeCounts)) {
        typeTotals[t] = (typeTotals[t] || 0) + c;
      }
    } catch (e: any) {
      failureCount++;
      failures.push({ path: f, error: e.message });
    }
  }

  console.log(`Batch results for ${arg}`);
  console.log(`  Files: ${files.length}`);
  console.log(`  Failures: ${failureCount}`);
  console.log(`  Empty output: ${emptyCount}`);
  console.log(`  Total sections: ${totalSections}`);
  console.log(`  Total warnings: ${warningCount}`);
  console.log(`  Type breakdown:`);
  for (const [t, c] of Object.entries(typeTotals).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${t}: ${c}`);
  }
  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures.slice(0, 10))
      console.log(`  - ${f.path}: ${f.error}`);
  }
  if (empties.length > 0) {
    console.log(`\nEmpty templates (first 5):`);
    for (const e of empties.slice(0, 5)) console.log(`  - ${e}`);
  }
}

main();

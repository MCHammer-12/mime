import { readFileSync, writeFileSync } from "fs";
import { parseKlaviyoHtml } from "./index.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npx tsx src/parser/smoke-test.ts <template.html>");
  process.exit(1);
}

const html = readFileSync(file, "utf-8");
const { sections, warnings, bodyBackgroundColor } = parseKlaviyoHtml(html);

console.log(`Parsed ${sections.length} sections:`);
for (const s of sections) {
  const summary =
    s.type === "text"
      ? `"${(s as any).text.slice(0, 50)}..."`
      : s.type === "image"
        ? `src=${(s as any).imageUrl.slice(0, 50)}...`
        : s.type === "button"
          ? `"${(s as any).buttonText}"`
          : s.type === "header"
            ? `${(s as any).headerType}`
            : s.type === "column"
              ? `${(s as any).columnCount} cols`
              : "";
  console.log(`  ${s.type} — ${summary}`);
}

if (warnings.length > 0) {
  console.log(`\n${warnings.length} warnings:`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
}

// Write output for viewer (include bodyBackgroundColor for renderer)
const outPath = file.replace(/\.html$/, ".sections.json");
writeFileSync(
  outPath,
  JSON.stringify({ sections, bodyBackgroundColor }, null, 2),
);
console.log(`\nWrote ${outPath}`);

import { parseKlaviyoHtml } from "./index.js";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

// Auto-discover every migrations/<merchant>/templates dir. The corpus is
// gitignored and populated by extract-templates.ts (which writes
// migrations/<MERCHANT>/templates), so the merchant names aren't known ahead
// of time — glob them rather than hardcoding.
const root = "migrations";
const dirs = existsSync(root)
  ? readdirSync(root)
      .map((m) => join(root, m, "templates"))
      .filter((d) => existsSync(d))
  : [];
let total = 0, clean = 0, warned = 0, failed = 0;

for (const dir of dirs) {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".html"));
    for (const f of files) {
      total++;
      try {
        const html = readFileSync(join(dir, f), "utf-8");
        const result = parseKlaviyoHtml(html);
        if (result.warnings.length === 0) clean++;
        else warned++;
      } catch {
        failed++;
      }
    }
  } catch {}
}
console.log(`Total: ${total}  Clean: ${clean}  Warned: ${warned}  Failed: ${failed}`);

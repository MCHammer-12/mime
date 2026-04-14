import { parseKlaviyoHtml } from "./index.js";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const dirs = ["migrations/test-account/templates", "migrations/merchant-2/templates"];
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

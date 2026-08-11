/**
 * Smoke test for double-quoted font names in inline styles (Diamond MMA,
 * 17/24 templates reported an unresolvable font family "&quot").
 *
 * cheerio escapes `"` inside an attribute value as `&quot;` whenever it
 * re-serializes a subtree. Every pass that scans that serialized HTML for CSS
 * splits declarations on `;` — and `&quot;` contains one — so
 * `font-family:"Helvetica Neue",Arial` truncated to `font-family:&quot`, which
 * then propagated into the block-level fontFamily and the font plan.
 * parseKlaviyoHtml now normalizes style attributes to single quotes on load.
 *
 *   npx tsx src/parser/style-quote-entities.smoke.ts
 */
import { exportTemplateFromHtml } from "../export-template.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const OPTS = { account: null, skipAi: true } as const;

// Mirrors Diamond MMA RG3nJP: kl-text td whose inner <h1> quotes the font name
// with double quotes. The attribute is single-quoted here so the source carries
// literal `"` — exactly what cheerio re-encodes on .html().
const html = `<html><body>
  <div class="component-wrapper">
    <table><tbody><tr>
      <td class="kl-text" style="padding:9px 18px;">
        <div style="text-align:center;line-height:1.3">
          <h1 style='color:#000; font-family: "Poppins", Arial; font-size:40px; font-weight:normal;'>Headline</h1>
        </div>
      </td>
    </tr></tbody></table>
  </div>
</body></html>`;

function fonts(node: any, out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) fonts(n, out);
    return out;
  }
  if (typeof node.fontFamily === "string") out.push(node.fontFamily);
  for (const k of Object.keys(node)) fonts(node[k], out);
  return out;
}

async function main() {
  const r = await exportTemplateFromHtml(html, { name: "quoted font" } as any, OPTS);
  const used = fonts(r.template.sections ?? []);

  const mangled = used.filter((f) => /&/.test(f));
  if (mangled.length > 0) {
    fail(`block fontFamily kept an HTML entity: ${JSON.stringify(mangled)}`);
  }
  if (!used.includes("Poppins")) {
    fail(`expected the quoted font to survive as "Poppins", got ${JSON.stringify(used)}`);
  }
  console.log('✓ double-quoted font name survives as "Poppins" on the block');

  const planned = (r.fontPlan?.entries ?? []).map((e: any) => e.family);
  if (planned.some((f: string) => /&/.test(f))) {
    fail(`font plan asked for an HTML entity: ${JSON.stringify(planned)}`);
  }
  if (!planned.includes("Poppins")) {
    fail(`font plan should request Poppins, got ${JSON.stringify(planned)}`);
  }
  console.log("✓ font plan requests Poppins, not an entity fragment");

  console.log("\nAll style-quote-entities smoke checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

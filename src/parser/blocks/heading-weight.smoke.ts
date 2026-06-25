/**
 * Smoke test for applyHeadingWeight (Tiny Boat "heading bold dropped").
 * Klaviyo bolds <h2>/<h3> via the document stylesheet; mime keeps the <h2>
 * tag but Redo doesn't apply the tag-default weight, so the bold was lost.
 * We now wrap h2/h3 content in <strong> explicitly (h1/h4 stay normal, and an
 * inline font-weight overrides).
 *
 *   npx tsx src/parser/blocks/heading-weight.smoke.ts
 */
import * as cheerio from "cheerio";
import { parseTextBlock } from "./text.js";
import type { ParseContext } from "../index.js";

function ctx(): ParseContext {
  return { warnings: [], unsupportedFeatures: [], reviewItems: [], skippedBlocks: [], storeUrl: null };
}
function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function run(inner: string): string {
  const $ = cheerio.load(`<table><tbody><tr><td class="kl-text"><div>${inner}</div></td></tr></tbody></table>`);
  const block = parseTextBlock($ as any, $("td.kl-text") as any, ctx());
  if (!block) throw new Error("parseTextBlock returned null");
  return block.text;
}

// h2 → bold (strong wraps the content)
{
  const out = run(`<h2 style="text-align:center"><span style="font-size:24px">Make Your Dumb Trolling Motor...SMART</span></h2>`);
  if (!/<h2[^>]*><strong><span/i.test(out)) fail(`h2 not wrapped in <strong>: ${out}`);
  console.log("✓ h2 → <strong> (bold restored)");
}
// h3 → bold
{
  const out = run(`<h3><span>Subhead</span></h3>`);
  if (!/<h3[^>]*><strong>/i.test(out)) fail(`h3 not bolded: ${out}`);
  console.log("✓ h3 → <strong>");
}
// h1 → NOT bolded (Klaviyo h1 is normal weight)
{
  const out = run(`<h1><span>Big title</span></h1>`);
  if (/<h1[^>]*><strong>/i.test(out)) fail(`h1 should NOT be force-bolded: ${out}`);
  console.log("✓ h1 left as-is (not force-bold)");
}
// inline font-weight override respected (no double weight)
{
  const out = run(`<h2><span style="font-weight:400">Light heading</span></h2>`);
  if (/<strong>/i.test(out)) fail(`inline font-weight:400 override should be respected: ${out}`);
  console.log("✓ inline font-weight override respected (no <strong>)");
}
// already-bold heading not double-wrapped
{
  const out = run(`<h2><strong>Already bold</strong></h2>`);
  if (/<strong>\s*<strong>/i.test(out)) fail(`double-wrapped: ${out}`);
  console.log("✓ already-bold heading not double-wrapped");
}

console.log("\nAll heading-weight smoke checks passed.");

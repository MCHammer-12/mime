/**
 * Smoke test for applyHeadingStyles (Tiny Boat "heading bold dropped" +
 * Invader Concepts "32px/400 heading rendered ~19px bold").
 * Klaviyo styles <hN> via the document stylesheet; mime keeps the tag but
 * Redo carries no heading CSS, so the template's rule is inlined onto the
 * tag and the weight made explicit: <strong> when bold (stock h2/h3 when the
 * template has no rule; h1/h4 stay normal; an inline font-weight overrides).
 *
 *   npx tsx src/parser/blocks/heading-weight.smoke.ts
 */
import * as cheerio from "cheerio";
import { parseTextBlock } from "./text.js";
import type { ParseContext } from "../index.js";
import { extractHeadingStyles, type HeadingStyles } from "../style-utils.js";

function ctx(headingStyles?: HeadingStyles): ParseContext {
  return { warnings: [], unsupportedFeatures: [], reviewItems: [], skippedBlocks: [], storeUrl: null, headingStyles };
}
function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function run(inner: string, headingStyles?: HeadingStyles, divStyle = ""): string {
  const $ = cheerio.load(`<table><tbody><tr><td class="kl-text"><div style="${divStyle}">${inner}</div></td></tr></tbody></table>`);
  const block = parseTextBlock($ as any, $("td.kl-text") as any, ctx(headingStyles));
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

// Template rule (Invader Concepts): h3 32px / 400 / 1.1 / margin 0 0 12px.
// Inlined onto the tag, merged into the existing style attr, NOT bolded.
{
  const rules: HeadingStyles = {
    h3: { "font-size": "32px", "font-weight": "400", "line-height": "1.1", margin: "0", "margin-bottom": "12px", color: "#373F47", "font-family": "Helvetica, Arial", "text-align": "left" },
  };
  const out = run(`<h3 style="text-align: center;">Hey, it's been a while...</h3>`, rules, "color:#373F47;font-size:16px;");
  if (!/<h3 style="text-align: center;font-size:32px;font-weight:400;line-height:1\.1;margin:0;margin-bottom:12px">Hey/i.test(out)) fail(`template h3 rule not inlined: ${out}`);
  if (/<strong>/i.test(out)) fail(`weight-400 template rule must not bold: ${out}`);
  if (/color:|font-family:|text-align:left/i.test(out.replace("text-align: center", ""))) fail(`only metrics should be inlined: ${out}`);
  console.log("✓ template h3 rule (32px/400) inlined, not bolded");
}
// Rule color that departs from the block color is a heading accent (Invader
// Concepts Loyalty h4 #DE6C58 on a #373F47 block) → inlined; same color → not.
{
  const rules: HeadingStyles = { h4: { "font-size": "24px", "font-weight": "400", color: "#DE6C58" } };
  const out = run(`<h4 style="text-align: center;">Ways to earn</h4>`, rules, "color:#373F47;font-size:16px;");
  if (!/<h4 style="text-align: center;font-size:24px;font-weight:400;color:#DE6C58">Ways/i.test(out)) fail(`accent color not inlined: ${out}`);
  const same = run(`<h4>Ways to earn</h4>`, rules, "color:#de6c58;");
  if (/color:/i.test(same)) fail(`block-matching color should not be inlined: ${same}`);
  const own = run(`<h4 style="color:#111111">Ways to earn</h4>`, rules, "color:#373F47;");
  if (/#DE6C58/i.test(own)) fail(`inline color on the tag must win: ${own}`);
  console.log("✓ heading rule color inlined only when it differs from the block color");
}
// Template rule says bold → inlined AND <strong>; bare tag gets a fresh style attr.
{
  const out = run(`<h2>Big deal</h2>`, { h2: { "font-size": "32px", "font-weight": "bold" } });
  if (!/<h2 style="font-size:32px;font-weight:bold"><strong>Big deal<\/strong><\/h2>/i.test(out)) fail(`bold template rule: ${out}`);
  console.log("✓ template h2 rule (32px/bold) inlined + <strong>");
}
// Inline declaration on the tag wins over the template rule.
{
  const out = run(`<h2 style="font-size:20px">Small</h2>`, { h2: { "font-size": "36px", "font-weight": "400" } });
  if (!/<h2 style="font-size:20px;font-weight:400">Small<\/h2>/i.test(out)) fail(`inline size should win: ${out}`);
  console.log("✓ inline font-size on the tag wins over the rule");
}
// Heading rule sizes don't hoist to the block level (mixed heading + body block).
{
  const $ = cheerio.load(`<table><tbody><tr><td class="kl-text"><div style="font-size:16px"><h3>Title</h3><p>Body copy</p></div></td></tr></tbody></table>`);
  const block = parseTextBlock($ as any, $("td.kl-text") as any, ctx({ h3: { "font-size": "32px" } }));
  if (block!.fontSize !== 16) fail(`block fontSize hoisted to heading size: ${block!.fontSize}`);
  if (!/<h3 style="font-size:32px"><strong>Title/i.test(block!.text)) fail(`h3 size not inlined: ${block!.text}`);
  console.log("✓ heading rule size stays on the tag, block fontSize untouched");
}
// extractHeadingStyles: reads the document <style>, skips @media overrides and comments.
{
  const $ = cheerio.load(`<html><head><style>
    /* h1 { font-size: 99px } */
    h1 { color: #373F47; font-size: 40px; font-weight: 400; }
    h3 {
      font-size: 32px;
      font-weight: 400;
      line-height: 1.1;
      margin: 0;
      margin-bottom: 12px;
    }
    @media only screen and (max-width: 480px) {
      h3 { font-size: 24px !important; line-height: 1.1 !important }
    }
    .kl-text h4, h4 { font-size: 24px }
  </style></head><body></body></html>`);
  const rules = extractHeadingStyles($);
  if (rules.h3?.["font-size"] !== "32px" || rules.h3?.["margin-bottom"] !== "12px") fail(`h3 rule: ${JSON.stringify(rules.h3)}`);
  if (rules.h1?.["font-size"] !== "40px") fail(`h1 rule: ${JSON.stringify(rules.h1)}`);
  if (rules.h4?.["font-size"] !== "24px") fail(`h4 via selector list: ${JSON.stringify(rules.h4)}`);
  if (rules.h2) fail(`no h2 rule expected: ${JSON.stringify(rules.h2)}`);
  console.log("✓ extractHeadingStyles reads document rules, skips @media + comments");
}

console.log("\nAll heading-weight smoke checks passed.");

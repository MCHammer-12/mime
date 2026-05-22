/**
 * Smoke test for text.ts. Locks in the post-2026-05-21 behavior:
 *
 *   - <p style="..."> in the source is MERGED with our text-align/line-height
 *     instead of getting a duplicate style attribute (which browsers drop
 *     to the first one, taking inline font-family with it).
 *   - Bare <p> still gets a fresh style attribute.
 *
 *   npx tsx src/parser/blocks/text.smoke.ts
 */
import * as cheerio from "cheerio";
import { parseTextBlock } from "./text.js";
import type { ParseContext } from "../index.js";

function emptyCtx(): ParseContext {
  return {
    warnings: [],
    unsupportedFeatures: [],
    reviewItems: [],
    skippedBlocks: [],
    storeUrl: null,
  };
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

function run(innerHtml: string): string {
  // Build a minimal kl-text wrapper td → div structure that parseTextBlock expects.
  const html = `
    <table><tbody><tr>
      <td class="kl-text" style="padding:9px 18px;">
        <div style="font-family:'Helvetica Neue',Arial;text-align:center;line-height:1.3;color:#fff;font-size:14px;">${innerHtml}</div>
      </td>
    </tr></tbody></table>
  `;
  const $ = cheerio.load(html);
  const $td = $("td.kl-text");
  const block = parseTextBlock($, $td, emptyCtx());
  if (!block) throw new Error("parseTextBlock returned null");
  return block.text;
}

// ─── Duplicate style attribute regression ─────────────────────────────────

// Klaviyo P with inline font-family — our text-align/line-height must merge
// into the existing style attribute, NOT create a second one.
{
  const out = run(
    `<p style="font-family: 'Futura', sans-serif; font-size:16px"><em>Body</em></p>`,
  );
  const styleAttrs = (out.match(/style\s*=/g) || []).length;
  assert(
    styleAttrs === 1,
    `single style attr on <p>, got ${styleAttrs} in ${out}`,
  );
  assert(
    /font-family:\s*'Futura'/.test(out),
    `font-family preserved in ${out}`,
  );
  assert(
    /text-align:\s*center/.test(out),
    `text-align merged in ${out}`,
  );
  assert(
    /line-height:\s*1\.3/.test(out),
    `line-height merged in ${out}`,
  );
}

// Bare <p> (no existing style) still gets a fresh attribute.
{
  const out = run(`<p>Plain text</p>`);
  const styleAttrs = (out.match(/style\s*=/g) || []).length;
  assert(styleAttrs === 1, `single style attr on bare <p>, got ${styleAttrs}`);
  assert(/text-align:\s*center/.test(out), `text-align set on bare <p>`);
}

// Mixed: one <p> with style, one bare — both get correct single style attr.
{
  const out = run(
    `<p>First</p>\n<p style="font-family: 'Futura', sans-serif">Second</p>`,
  );
  const styleAttrs = (out.match(/style\s*=/g) || []).length;
  assert(styleAttrs === 2, `one style per <p>, got ${styleAttrs} in ${out}`);
  assert(/font-family:\s*'Futura'/.test(out), `font-family preserved`);
}

// Trailing semicolon in existing style is handled (no double semicolon).
{
  const out = run(`<p style="color:#fff;">Body</p>`);
  assert(!/;;/.test(out), `no double semicolon in ${out}`);
  assert(/color:#fff/.test(out), `existing color preserved`);
  assert(/text-align:\s*center/.test(out), `text-align merged`);
}

// Other attributes on <p> (class, data-*) survive the merge.
{
  const out = run(
    `<p class="lead" data-x="1" style="font-family: Futura">Body</p>`,
  );
  assert(/class="lead"/.test(out), `class survived in ${out}`);
  assert(/data-x="1"/.test(out), `data-* survived in ${out}`);
  const styleAttrs = (out.match(/style\s*=/g) || []).length;
  assert(styleAttrs === 1, `single style attr, got ${styleAttrs}`);
}

console.log("text.smoke.ts: all assertions passed");

/**
 * Smoke test for parseTableImageRow — Klaviyo "Table" block used as a
 * trust-bar / badge row (Tiny Boat Welcome #1). Each kl-table-subblock cell
 * holds a badge image; without this handler the whole table fell through to
 * "Unknown block" and every badge was dropped.
 *
 *   npx tsx src/parser/blocks/trust-bar.smoke.ts
 */
import * as cheerio from "cheerio";
import { parseTableImageRow } from "./column.js";
import { EmailBlockType } from "../../renderer/types.js";
import type { ParseContext } from "../index.js";

function emptyCtx(): ParseContext {
  return { warnings: [], unsupportedFeatures: [], reviewItems: [], skippedBlocks: [], storeUrl: null };
}
function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function cell(n: number): string {
  return `<td class="kl-table-subblock"><table><tbody><tr>
    <td class="kl-img-base-auto-width" style="width:83px;padding:4px;">
      <a class="kl-img-link" href="https://tinyboatnation.com/badge${n}">
        <img src="https://cdn.example.com/badge${n}.png" width="83" alt="badge ${n}"/>
      </a>
    </td></tr></tbody></table></td>`;
}
function wrapper(cells: string): cheerio.CheerioAPI {
  return cheerio.load(`<div class="component-wrapper"><table><tbody><tr>
    <td class="kl-table"><table><tbody><tr>${cells}</tr></tbody></table></td>
  </tr></tbody></table></div>`);
}

// ─── 3 badge cells → 3-column ColumnBlock of images ───────────────────────
{
  const $ = wrapper(cell(1) + cell(2) + cell(3));
  const ctx = emptyCtx();
  const block = parseTableImageRow($ as any, $("div.component-wrapper") as any, ctx);
  if (!block) fail("3-cell trust bar returned null (badges would be dropped)");
  if (block.type !== EmailBlockType.COLUMN) fail(`expected a ColumnBlock, got ${block.type}`);
  if (block.columnCount !== 3) fail(`expected columnCount 3, got ${block.columnCount}`);
  const types = block.columns.map((c) => c?.type);
  if (!types.every((t) => t === EmailBlockType.IMAGE)) fail(`expected all image columns, got ${types.join(",")}`);
  const urls = block.columns.map((c: any) => c?.imageUrl);
  if (!urls.every((u: string) => /badge[123]\.png$/.test(u || ""))) fail(`columns lost their image src: ${urls.join(",")}`);
  // clickthroughs preserved from kl-img-link
  const links = block.columns.map((c: any) => c?.clickthroughUrl);
  if (!links.every((l: string) => /tinyboatnation\.com\/badge/.test(l || ""))) fail(`badge clickthroughs lost: ${links.join(",")}`);
  if (!block.columnWidths || block.columnWidths.length !== 3) fail("expected 3 columnWidths");
  console.log("✓ 3-image kl-table → 3-column ColumnBlock, srcs + links preserved");
}

// ─── single-image table → null (left to other handlers, not reshaped) ─────
{
  const $ = wrapper(cell(1));
  const block = parseTableImageRow($ as any, $("div.component-wrapper") as any, emptyCtx());
  if (block !== null) fail("a lone-image kl-table should return null, not a 1-column block");
  console.log("✓ lone-image kl-table → null (not speculatively reshaped)");
}

// ─── no kl-table → null ───────────────────────────────────────────────────
{
  const $ = cheerio.load(`<div class="component-wrapper"><td class="kl-text"><p>hi</p></td></div>`);
  const block = parseTableImageRow($ as any, $("div.component-wrapper") as any, emptyCtx());
  if (block !== null) fail("non-table wrapper should return null");
  console.log("✓ no kl-table → null");
}

console.log("\nAll trust-bar smoke checks passed.");

/**
 * Smoke test for parseTableImageRows — Klaviyo "Table" block used as a
 * trust-bar / badge row (Tiny Boat Welcome #1). Each kl-table-subblock cell
 * holds a badge image; without this handler the whole table fell through to
 * "Unknown block" and every badge was dropped. A multi-row table (Jack Henry
 * Welcome #1 / #3: 2×2 static product cards) emits one ColumnBlock per row.
 *
 *   npx tsx src/parser/blocks/trust-bar.smoke.ts
 */
import * as cheerio from "cheerio";
import { parseTableImageRows } from "./column.js";
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
function wrapper(...rows: string[]): cheerio.CheerioAPI {
  const trs = rows.map((cells) => `<tr>${cells}</tr>`).join("");
  return cheerio.load(`<div class="component-wrapper"><table><tbody><tr>
    <td class="kl-table"><table><tbody>${trs}</tbody></table></td>
  </tr></tbody></table></div>`);
}

// ─── 3 badge cells → 3-column ColumnBlock of images ───────────────────────
{
  const $ = wrapper(cell(1) + cell(2) + cell(3));
  const ctx = emptyCtx();
  const blocks = parseTableImageRows($ as any, $("div.component-wrapper") as any, ctx);
  if (blocks.length !== 1) fail(`3-cell trust bar should be one row, got ${blocks.length} blocks`);
  const block = blocks[0];
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

// ─── 2×2 product-card table → two 2-column ColumnBlocks, row order kept ───
{
  const $ = wrapper(cell(1) + cell(2), cell(3) + cell(4));
  const blocks = parseTableImageRows($ as any, $("div.component-wrapper") as any, emptyCtx());
  if (blocks.length !== 2) fail(`2×2 kl-table should be two rows, got ${blocks.length} blocks`);
  for (const b of blocks) {
    if (b.columnCount !== 2) fail(`each row should have 2 columns, got ${b.columnCount}`);
    if (!b.columnWidths || b.columnWidths.join(",") !== "50,50") fail(`expected 50/50 widths, got ${b.columnWidths}`);
  }
  const order = blocks.flatMap((b) => b.columns.map((c: any) => c?.imageUrl?.match(/badge(\d)/)?.[1]));
  if (order.join("") !== "1234") fail(`rows/cells out of order: ${order.join(",")}`);
  console.log("✓ 2×2 kl-table → two 2-column ColumnBlocks (not one 4-across row)");
}

// ─── single-image table → nothing (left to other handlers, not reshaped) ──
{
  const $ = wrapper(cell(1));
  const blocks = parseTableImageRows($ as any, $("div.component-wrapper") as any, emptyCtx());
  if (blocks.length !== 0) fail("a lone-image kl-table should return nothing, not a 1-column block");
  console.log("✓ lone-image kl-table → nothing (not speculatively reshaped)");
}

// ─── no kl-table → nothing ────────────────────────────────────────────────
{
  const $ = cheerio.load(`<div class="component-wrapper"><td class="kl-text"><p>hi</p></td></div>`);
  const blocks = parseTableImageRows($ as any, $("div.component-wrapper") as any, emptyCtx());
  if (blocks.length !== 0) fail("non-table wrapper should return nothing");
  console.log("✓ no kl-table → nothing");
}

console.log("\nAll trust-bar smoke checks passed.");

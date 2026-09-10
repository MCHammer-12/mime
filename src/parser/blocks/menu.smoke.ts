// Smoke: header link bar → MenuBlock, both Klaviyo variants.
//   npx tsx src/parser/blocks/menu.smoke.ts
import * as cheerio from "cheerio";
import { parseMenuFromHeader } from "./menu.js";
import type { ParseContext } from "../index.js";

function emptyCtx(): ParseContext {
  return { warnings: [], unsupportedFeatures: [], reviewItems: [], skippedBlocks: [], storeUrl: null };
}
function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const LINK_STYLE = `color:#000; text-decoration:none; font-family:'Helvetica Neue', Arial; font-size:14px; font-weight:400;`;
function bar(cellClass: string, items: string[]): string {
  const cells = items
    .map((inner) => `<td align="center" class="${cellClass}" valign="middle"><table class="lnk"><tr><td>${inner}</td></tr></table></td>`)
    .join("");
  return `<div class="component-wrapper hlb-wrapper"><table><tr>
    <td class="hlb-block-settings-content" style="padding:9px 18px 9px 18px;">
      <table><tr><td class="kl-header-link-bar"><table>
        <tr><td class="hlb-logo"><img src="https://x/logo.png" width="150"/></td></tr>
        <tr><td><table class="r2-tbl"><tr>${cells}</tr></table></td></tr>
      </table></td></tr></table>
    </td></tr></table></div>`;
}
function run(html: string) {
  const $ = cheerio.load(html);
  return parseMenuFromHeader($, $(".hlb-wrapper").first(), emptyCtx());
}

// Stacked variant (kl-hlb-stack): a real link plus an unlinked <p href=""> item.
{
  const menu = run(bar("kl-hlb-stack block vspc hlb-subblk", [
    `<a href="http://nwretention.com" style="${LINK_STYLE}" target="_blank"> Shop Now </a>`,
    `<p href="" style="${LINK_STYLE}"> New </p>`,
  ]));
  if (!menu) fail("stacked header link bar produced no menu");
  const labels = menu.menuItems.map((m) => m.label);
  if (labels.length !== 2) fail(`expected 2 items, got ${labels.length}: ${JSON.stringify(labels)}`);
  if (!/href="http:\/\/nwretention\.com"[^>]*>Shop Now</.test(labels[0]!)) fail(`first item: ${labels[0]}`);
  if (!/href="#"[^>]*>New</.test(labels[1]!)) fail(`unlinked item should carry href="#": ${labels[1]}`);
  if (menu.stackOnMobile !== true) fail("kl-hlb-stack should set stackOnMobile");
  if (menu.sectionPadding.top !== 0 || menu.sectionPadding.left !== 18) fail(`padding: ${JSON.stringify(menu.sectionPadding)}`);
  console.log("✓ stacked link bar → 2 items, unlinked item kept, stackOnMobile");
}

// Inline variant (kl-hlb-wrap) still works and stays inline on mobile.
{
  const menu = run(bar("kl-hlb-wrap block hlb-subblk", [
    `<a href="https://shop.example/collections/all" style="${LINK_STYLE}">Shop</a>`,
    `<a href="https://shop.example/pages/about" style="${LINK_STYLE}">About</a>`,
    `<a href="https://shop.example/pages/contact" style="${LINK_STYLE}">Contact</a>`,
  ]));
  if (!menu || menu.menuItems.length !== 3) fail(`inline bar: ${JSON.stringify(menu?.menuItems)}`);
  if (menu.stackOnMobile !== false) fail("kl-hlb-wrap should not stack on mobile");
  console.log("✓ inline link bar → 3 items, no stacking");
}

// A bar with only a logo and no link cells is not a menu.
{
  if (run(bar("kl-hlb-stack", [])) !== null) fail("logo-only bar should yield no menu");
  console.log("✓ logo-only bar → null");
}

console.log("\nAll menu smoke checks passed.");

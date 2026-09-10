/**
 * Smoke test for parseProductBlock on a Klaviyo STATIC product grid (Invader
 * Concepts "BEST SELLERS"). Each merchant-picked cell links its image and its
 * "Shop now" button to the PDP, prints the price as text, and styles the
 * button inline. The parser has to keep all three — the href is what the
 * importer resolves to a Shopify id, and the price/button presence is the
 * merchant's show/hide setting — instead of a bare name list with the price
 * and button hard-coded off.
 *
 *   npx tsx src/parser/blocks/static-products.smoke.ts
 */
import * as cheerio from "cheerio";
import { parseProductBlock } from "./product.js";
import { EmailBlockType } from "../../renderer/types.js";
import type { ParseContext } from "../index.js";

function emptyCtx(): ParseContext {
  return { warnings: [], unsupportedFeatures: [], reviewItems: [], skippedBlocks: [], storeUrl: null };
}
function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const STORE = "https://northwest-retention.myshopify.com";

function cell(opts: { handle: string; name: string; price?: string; button?: boolean; link?: boolean }): string {
  const href = opts.link === false ? "" : ` href="${STORE}/products/${opts.handle}"`;
  const price = opts.price
    ? `<tr><td align="center"><table align="center"><tr>
         <td align="center" style="color:#FFFFFF;font-family:Helvetica,Arial;font-size:16px;font-weight:400;padding-top:5px;">${opts.price}</td>
       </tr></table></td></tr>`
    : "";
  const button = opts.button === false
    ? ""
    : `<tr><td align="center" style="padding-top:9px;"><table><tr>
         <td align="center" bgcolor="#FFD600" style="border:none;border-radius:5px;color:#000000;font-family:'Montserrat', Helvetica, Arial, sans-serif;font-size:16px;background:#FFD600;">
           <a${href} style='color:#000; text-decoration:none; display:inline-block; background:#FFD600; font-family:"Montserrat", Helvetica, Arial, sans-serif; font-size:16px; padding:10px 10px 10px 10px; border-radius:5px'> Shop now </a>
         </td>
       </tr></table></td></tr>`;
  return `<div class="kl-product-cell-stack" style="display:table-cell;vertical-align:top;font-size:0;width:33.333333333333336%;">
    <table width="100%"><tbody><tr><td style="padding:10px 10px 10px 10px;">
      <table class="kl-product-subblock" width="100%"><tbody>
        <tr><td align="center"><a${href}><img alt="Image of ${opts.name}" src="https://cdn.shopify.com/s/files/1/0607/3237/5201/files/${opts.handle}.jpg" style="display:block;max-width:100%;width:auto;max-height:125px;" width="176"/></a></td></tr>
        <tr><td align="center"><table align="center"><tr>
          <td align="center" style="color:#FFFFFF;font-family:Helvetica,Arial;font-size:16px;font-weight:700;padding-top:5px;">${opts.name}</td>
        </tr></table></td></tr>
        ${price}
        <tr><td style="height:100%;"></td></tr>
        ${button}
      </tbody></table>
    </td></tr></tbody></table>
  </div>`;
}

function grid(cells: string): cheerio.CheerioAPI {
  return cheerio.load(`<div class="component-wrapper"><table><tbody><tr>
    <td style="padding:9px 18px 9px 18px;background-color:#252525;">
      <div class="kl-product" style="display:table;width:100%;height:100%">${cells}</div>
    </td></tr></tbody></table></div>`);
}

// ─── Invader-shaped grid: link + price + yellow button per cell ────────────
{
  const $ = grid(
    cell({ handle: "recon-chest-holster", name: "RECON Chest Holster", price: "$159.95" }) +
      cell({ handle: "guide-torso-holster", name: "GUIDE Torso Holster", price: "$149.95" }) +
      cell({ handle: "hitchhiker-mag-carrier", name: "HITCHHIKER Mag Carrier", price: "$39.95" }),
  );
  const ctx = emptyCtx();
  const sections = parseProductBlock($ as any, $("div.kl-product") as any, ctx);
  if (sections.length !== 1) fail(`expected 1 section, got ${sections.length}`);
  const block: any = sections[0];
  if (block.type !== EmailBlockType.PRODUCTS) fail(`expected a Products block, got ${block.type}`);
  if (block.productSelectionType !== "static") fail(`expected static selection, got ${block.productSelectionType}`);
  if (block.columns !== 3) fail(`expected 3 columns, got ${block.columns}`);
  if (block.numberOfProducts !== 3) fail(`expected numberOfProducts 3, got ${block.numberOfProducts}`);
  const pending = block._pendingProducts;
  if (!pending || pending.length !== 3) fail(`expected 3 pending products, got ${JSON.stringify(pending)}`);
  const urls = pending.map((p: any) => p.url);
  if (urls[0] !== `${STORE}/products/recon-chest-holster`) fail(`first cell lost its PDP link: ${urls[0]}`);
  if (urls[2] !== `${STORE}/products/hitchhiker-mag-carrier`) fail(`third cell lost its PDP link: ${urls[2]}`);
  if (pending[1].name !== "GUIDE Torso Holster") fail(`title lost: ${pending[1].name}`);
  if (block.showPrice !== true) fail("a cell printing $159.95 must keep showPrice on");
  if (block.showButton !== true) fail("a cell with a Shop now button must keep showButton on");
  const b = block.lineItemButtons;
  if (b.fillColor.toLowerCase() !== "#ffd600") fail(`button fill lost: ${b.fillColor}`);
  if (b.buttonText !== "Shop now") fail(`button text lost: ${b.buttonText}`);
  if (b.cornerRadius !== 5) fail(`button radius lost: ${b.cornerRadius}`);
  if (b.fontFamily !== "Montserrat") fail(`button font lost: ${b.fontFamily}`);
  if (block.checkoutButton.buttonText !== "Checkout") fail(`checkout button text: ${block.checkoutButton.buttonText}`);
  if (block.checkoutButton.fillColor.toLowerCase() !== "#ffd600") fail("checkout button should inherit the cell button style");
  if (block.sectionColor !== "#252525") fail(`section color lost: ${block.sectionColor}`);
  console.log("✓ static grid keeps PDP links, price, and the styled Shop now button");
}

// ─── title-only cells: no price, no button, no link ───────────────────────
{
  const $ = grid(
    cell({ handle: "a", name: "Alpha", button: false, link: false }) +
      cell({ handle: "b", name: "Bravo", button: false, link: false }),
  );
  const sections = parseProductBlock($ as any, $("div.kl-product") as any, emptyCtx());
  const block: any = sections[0];
  if (block.showPrice !== false) fail("no price text → showPrice must stay off");
  if (block.showButton !== false) fail("no button → showButton must stay off");
  if (block._pendingProducts.some((p: any) => p.url)) fail("cells without links must not invent a url");
  if (block._pendingProducts.map((p: any) => p.name).join(",") !== "Alpha,Bravo") fail("names lost on link-less cells");
  console.log("✓ link-less, price-less cells keep names only with price/button off");
}

// ─── side-by-side layout: text column td wraps title+price+button, image td after ──
{
  const $ = cheerio.load(`<div class="component-wrapper"><table><tbody><tr>
    <td style="padding:0;background-color:#1a1a1a;">
      <div class="kl-product" style="display:table;width:100%;">
        <div class="" style="display:table-cell;width:100%;">
          <table width="100%"><tbody><tr><td style="padding:10px;">
            <table class="kl-product-subblock" width="100%"><tbody><tr>
              <td>
                <table width="100%">
                  <tr><td align="center"><table align="center"><tr>
                    <td align="center" style="color:#FFFFFF;font-family:'Nunito Sans', Helvetica;font-size:20px;font-weight:800;">
                      <a href="${STORE}/products/ic-multicam-trucker-snapback" style="color:#FFF">IC Multicam Trucker Snapback</a>
                    </td></tr></table></td></tr>
                  <tr><td align="center"><table align="center"><tr>
                    <td align="center" style="color:#FFD600;font-size:20px;">$36.95</td>
                  </tr></table></td></tr>
                  <tr><td align="center"><table><tr>
                    <td align="center" bgcolor="#FFD600" style="border-radius:5px;color:#2B2B1F;font-size:16px;background:#FFD600;">
                      <a href="${STORE}/products/ic-multicam-trucker-snapback" style="color:#2B2B1F; background:#FFD600; font-size:16px; padding:10px 10px 10px 10px; border-radius:5px"> Shop now </a>
                    </td></tr></table></td></tr>
                </table>
              </td>
              <td align="center"><a href="${STORE}/products/ic-multicam-trucker-snapback"><img alt="Image of IC Multicam Trucker Snapback" src="https://cdn.shopify.com/s/files/1/0607/3237/5201/files/IC-Hat.jpg" style="max-height:250px;" width="176"/></a></td>
            </tr></tbody></table>
          </td></tr></tbody></table>
        </div>
      </div>
    </td></tr></tbody></table></div>`);
  const sections = parseProductBlock($ as any, $("div.kl-product") as any, emptyCtx());
  const block: any = sections[0];
  const pending = block._pendingProducts;
  if (pending.length !== 1) fail(`expected 1 product, got ${JSON.stringify(pending)}`);
  if (pending[0].name !== "IC Multicam Trucker Snapback") fail(`title must be the leaf td, not the whole text column: ${JSON.stringify(pending[0].name)}`);
  if (pending[0].url !== `${STORE}/products/ic-multicam-trucker-snapback`) fail(`PDP link lost: ${pending[0].url}`);
  if (block.showPrice !== true) fail("side-by-side cell printing $36.95 must keep showPrice on");
  if (block.showButton !== true) fail("side-by-side cell with a Shop now button must keep showButton on");
  if (block.titleFontSize !== 20) fail(`title size must come from the leaf title td: ${block.titleFontSize}`);
  console.log("✓ side-by-side cell: title is the leaf td, price/button/link kept");
}

console.log("all static product grid smoke checks passed");

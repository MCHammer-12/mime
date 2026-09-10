/**
 * Smoke test for parseBrowseAbandonmentCardBlock on a Klaviyo browse-
 * abandonment "product card" (Invader Concepts "Holsters For Adventure
 * Carry"): a hand-built kl-table with {{ event.ImageURL }} / {{ event.Name }}
 * / {{ event.Price }} and no Liquid loop. Redo has a `viewed_products`
 * recommendation type for exactly this, so the block must carry that
 * filter — not the old Best Sellers fallback.
 *
 *   npx tsx src/parser/blocks/browse-card.smoke.ts
 */
import * as cheerio from "cheerio";
import { parseBrowseAbandonmentCardBlock } from "./product.js";
import { EmailBlockType } from "../../renderer/types.js";
import type { ParseContext } from "../index.js";

function emptyCtx(): ParseContext {
  return { warnings: [], unsupportedFeatures: [], reviewItems: [], skippedBlocks: [], storeUrl: null };
}
function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const CARD = `<div class="component-wrapper"><table width="100%"><tbody><tr>
  <td style="padding-top:9px;padding-right:18px;padding-bottom:9px;padding-left:18px;">
    <table width="100%"><tbody><tr><td class="kl-table" style="padding:0px;">
      <table style="font-family:Ubuntu, Helvetica, Arial, sans-serif;width:100%;" width="100%"><tbody><tr>
        <td class="kl-table-subblock" style="width:35%;">
          <a class="kl-img-link" href="{{ event.URL }}"><img alt="" src="{{ event.ImageURL }}" width="200"/></a>
        </td>
        <td class="kl-table-subblock" style="width:65%;">
          <div style="font-family:'Nunito Sans', Helvetica, Arial, sans-serif;font-size:14px;color:#FFFFFF;">
            <h3><a href="{{ event.URL }}">{{ event.Name }}</a></h3>
            <p>Price: {{ event.Price|striptags }}</p>
          </div>
        </td>
      </tr></tbody></table>
    </td></tr></tbody></table>
  </td></tr></tbody></table></div>`;

{
  const $ = cheerio.load(CARD);
  const ctx = emptyCtx();
  const block = parseBrowseAbandonmentCardBlock($, $(".component-wrapper"), ctx);
  if (!block) fail("BA card not recognised");
  if (block.type !== EmailBlockType.PRODUCTS) fail(`type ${block.type}`);
  if (block.productSelectionType !== "dynamic") fail(`selection ${block.productSelectionType}`);
  if (block.numberOfProducts !== 1) fail(`numberOfProducts ${block.numberOfProducts}`);
  const filter = block._pendingFilter;
  if (!filter) fail("no _pendingFilter");
  if (filter.productRecommendationType !== "viewed_products")
    fail(`filter type ${filter.productRecommendationType} (expected viewed_products)`);
  if (filter.unit !== "day" || !filter.value) fail(`lookback ${filter.unit}/${filter.value}`);
  if (!ctx.warnings.some((w) => /viewed_products/.test(w) && !/Best Sellers/.test(w)))
    fail(`warning still describes the Best Sellers fallback: ${JSON.stringify(ctx.warnings)}`);
  console.log("✓ BA card → dynamic 1-product block on the viewed_products filter");
}

{
  const $ = cheerio.load(`<div class="component-wrapper"><table><tbody><tr><td>
    <p>Still thinking about {{ event.Name }}?</p></td></tr></tbody></table></div>`);
  const block = parseBrowseAbandonmentCardBlock($, $(".component-wrapper"), emptyCtx());
  if (block) fail("text mentioning an event variable outside a kl-table was treated as a card");
  console.log("✓ inline {{ event.Name }} in a text block is not a card");
}

console.log("all browse-abandonment card smoke checks passed");

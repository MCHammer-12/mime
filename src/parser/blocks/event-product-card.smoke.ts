/**
 * Smoke test for the kl-split event product card (Jack Henry Added to Cart,
 * Klaviyo template XVCYvV). Klaviyo lays the event's product out as a
 * kl-split: product image (`{{ event.ImageUrl }}`) on the left, title and
 * `{% currency_format event.Price %}` on the right. Parsed as a layout column
 * this became an image with an empty src next to gutted text; it must become
 * a Products block on Redo's "Products from this trigger" source.
 *
 *   npx tsx src/parser/blocks/event-product-card.smoke.ts
 */
import { parseKlaviyoHtml } from "../index.js";
import { TRIGGER_PRODUCTS_FILTER_ID } from "./product.js";
import { EmailBlockType } from "../../renderer/types.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function splitWrapper(img: string, text: string): string {
  return `<div class="component-wrapper"><table><tbody><tr>
    <td style="padding-top:9px;padding-right:18px;padding-bottom:9px;padding-left:18px;">
    <table><tbody><tr><td class="kl-split" style="padding:0px;">
      <div style="font-family:Ubuntu, Helvetica, Arial, sans-serif;font-size:13px;">
      <div style="display:table;width:100%;">
        <div class="kl-split-subblock top" style="display:table-cell;vertical-align: top;width:40%">
          <table><tbody><tr><td class="spacer" style="padding-right:18px;">
            <a class="kl-img-link" href="{{ event.URL }}">${img}</a>
          </td></tr></tbody></table>
        </div>
        <div class="kl-split-subblock bottom" style="display:table-cell;vertical-align: top;width:60%">
          <table><tbody><tr><td class="spacer" style="padding-left:18px;">
            <div style="font-family:'Helvetica Neue',Arial;font-size:14px;color:#222222;">${text}</div>
          </td></tr></tbody></table>
        </div>
      </div>
      </div>
    </td></tr></tbody></table>
    </td></tr></tbody></table></div>`;
}

const EVENT_IMG = `<img alt="" src="{{ event.ImageUrl|default:'' }}" width="200"/>`;
const EVENT_TEXT = `<h3><span>{{ event.Title|default:'' }}</span></h3>
  <p style="padding-bottom:0"><strong>Price: </strong>{% currency_format event.Price|floatformat:2 %}</p>`;

// ─── event image + event title/price split → trigger-products grid ────────
{
  const r = parseKlaviyoHtml(splitWrapper(EVENT_IMG, EVENT_TEXT));
  if (r.sections.length !== 1) fail(`expected 1 section, got ${r.sections.length}`);
  const b = r.sections[0] as any;
  if (b.type !== EmailBlockType.PRODUCTS) fail(`expected a Products block, got ${b.type}`);
  if (b.productSelectionType !== "dynamic") fail("expected a dynamic grid");
  if (b.recommendedProductFilterId !== TRIGGER_PRODUCTS_FILTER_ID) fail("expected the trigger-products sentinel");
  if ("_pendingFilter" in b) fail("sentinel grid must not request a filter");
  if (b.fontFamily === "Ubuntu") fail("card inherited Klaviyo's MJML default font stack");
  const pad = b.sectionPadding;
  if (pad.top !== 9 || pad.right !== 18 || pad.bottom !== 9 || pad.left !== 18) fail(`section padding lost: ${JSON.stringify(pad)}`);
  if (!r.warnings.some((w) => /Product card \(kl-split/.test(w))) fail("missing the product-card warning");
  if (r.warnings.some((w) => /Dropped Klaviyo-only Liquid/.test(w))) fail("event variables must not be reported as dropped Liquid");
  console.log("✓ kl-split event card → Products block on the trigger-products source");
}

// ─── ordinary split (static image + copy) still parses as a column ────────
{
  const r = parseKlaviyoHtml(
    splitWrapper(
      `<img alt="" src="https://d3k81ch9hvuctc.cloudfront.net/company/WQFZDV/images/abc123.png" width="200"/>`,
      `<h3>Made to move</h3><p>Copy about the collection.</p>`,
    ),
  );
  if (r.sections.length !== 1) fail(`expected 1 section, got ${r.sections.length}`);
  const b = r.sections[0] as any;
  if (b.type !== EmailBlockType.COLUMN) fail(`expected a Column block, got ${b.type}`);
  if (b.columns[0]?.type !== EmailBlockType.IMAGE || !/abc123\.png$/.test(b.columns[0].imageUrl)) fail("static split lost its image");
  console.log("✓ static kl-split still → Column block");
}

// ─── split that only mentions an event variable in copy is not a card ─────
{
  const r = parseKlaviyoHtml(
    splitWrapper(
      `<img alt="" src="https://d3k81ch9hvuctc.cloudfront.net/company/WQFZDV/images/abc123.png" width="200"/>`,
      `<p>Still thinking about {{ event.Title|default:'it' }}?</p>`,
    ),
  );
  const b = r.sections[0] as any;
  if (b?.type !== EmailBlockType.COLUMN) fail(`expected a Column block, got ${b?.type}`);
  console.log("✓ static image + event variable in copy → Column block (not reshaped)");
}

console.log("\nAll event-product-card smoke checks passed.");

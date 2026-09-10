/**
 * Smoke test for the dynamic-image → text-block conversion in preparePayload
 * (Any Means Necessary back-in-stock, 2026-09-09).
 *
 *   npx tsx src/migrate/dynamic-image-inline.smoke.ts
 *
 * Redo's Image block never runs `imageUrl` through Liquid, so a Klaviyo product
 * card whose image is `{{ catalog_item.featured_image.full.src }}` maps to a
 * valid token and then renders as literal text in the delivered email. Text
 * blocks do render Liquid, so the importer ships the image as an inline
 * `<img>` inside one. Stubs global.fetch (no network) and captures the
 * createEmailTemplate payload.
 */
import { importTemplateRpc, type ImportProgressEvent } from "./import-rpc.js";

process.env.SKIP_IMAGE_REHOST = "1";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`FAIL: ${msg}`);
    failures++;
  }
}

let captured: any = null;
(globalThis as any).fetch = async (url: string, init?: any) => {
  const u = String(url);
  const parsed = init?.body ? JSON.parse(init.body) : {};
  if (u.includes("/marketing-rpc/createEmailTemplate")) {
    captured = parsed.input;
    return new Response(JSON.stringify({ output: { _id: "aaaaaaaaaaaaaaaaaaaaaaaa" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`smoke fetch: unexpected URL ${u}`);
};

const STATIC_URL = "https://cdn.example.com/hero.png";
const events: ImportProgressEvent[] = [];

await importTemplateRpc(
  {
    name: "Back In Stock (smoke)",
    sections: [
      {
        type: "image",
        blockId: "static",
        imageUrl: STATIC_URL,
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
        showCaption: false,
      },
      {
        type: "image",
        blockId: "card",
        sectionPadding: { top: 0, right: 40, bottom: 0, left: 40 },
        imageUrl: "{{ restocked_product.image_url }}",
        altText: 'Back "in" stock',
        padding: { top: 8, right: 0, bottom: 12, left: 0 },
        showCaption: true,
        caption: "Now available",
        clickthroughLinkType: "dynamic-variable",
        clickthroughSchemaFieldName: "back_in_stock_product_url",
        imageSourceType: "url",
      },
    ],
  },
  { jwt: "stub.jwt.token", serverBase: "https://stub.local", onProgress: (e) => events.push(e) },
);

const [staticBlock, card] = captured.sections;

assert(staticBlock.type === "image" && staticBlock.imageUrl === STATIC_URL, "static image block left untouched");

assert(card.type === "text", `dynamic image became a text block (got ${card.type})`);
assert(card.blockId === "card" && card.sectionPadding?.left === 40, "section-level fields preserved");
assert(!("imageUrl" in card) && !("imageSourceType" in card), "image-only fields stripped");
assert(
  card.text.includes('<img src="{{ restocked_product.image_url }}"'),
  `token lands in the <img src>, got: ${card.text}`,
);
assert(card.text.includes('alt="Back &quot;in&quot; stock"'), "alt text escaped");
assert(card.text.includes("padding:8px 0px 12px 0px"), "block padding folded into inline style");
assert(
  card.text.includes('<a href="{{ back_in_stock_product_url }}">'),
  `dynamic clickthrough becomes a Liquid href, got: ${card.text}`,
);
assert(card.text.includes("<p style=\"text-align:center\">Now available</p>"), "caption kept");

const inlined = events.filter((e) => e.kind === "dynamic_image_inlined");
assert(
  inlined.length === 1 && (inlined[0] as any).imageUrl === "{{ restocked_product.image_url }}",
  "exactly one dynamic_image_inlined event, for the card",
);

if (failures) {
  console.error(`dynamic-image-inline.smoke.ts: ${failures} failure(s)`);
  process.exit(1);
}
console.log("dynamic-image-inline.smoke.ts: all assertions passed");

/**
 * Smoke test for static product grid resolution in preparePayload
 * (Any Means Necessary welcome series, 2026-09-09).
 *
 *   npx tsx src/migrate/static-products-resolve.smoke.ts
 *
 * A Klaviyo static grid carries the merchant's product links; the importer
 * resolves each `/products/<handle>` through the public storefront
 * `/products/<handle>.js` and pins the products in `manuallySelectedProducts`.
 * Stubs global.fetch (no network) for the storefront + createEmailTemplate
 * and captures the payloads.
 */
import { importTemplateRpc, type ImportOptions, type ImportProgressEvent } from "./import-rpc.js";

process.env.SKIP_IMAGE_REHOST = "1";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`FAIL: ${msg}`);
    failures++;
  }
}

const STORE = "https://smoke-store.myshopify.com";
const storefront: Record<string, any> = {
  "morality-t-shirt": {
    id: 7488897679427,
    variants: [
      { id: 1001, title: "XS", available: false },
      { id: 1002, title: "S", available: true },
    ],
  },
  "mayhem-t-shirt": {
    id: 7488897679428,
    variants: [{ id: 2001, title: "S", available: true }, { id: 2002, title: "M", available: true }],
  },
  "sold-out-hoodie": {
    id: 7488897679429,
    variants: [{ id: 3001, title: "S", available: false }],
  },
};

const captured: any[] = [];
const storefrontHits: string[] = [];
let filterCreates = 0;
(globalThis as any).fetch = async (url: string, init?: any) => {
  const u = String(url);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (u.startsWith(`${STORE}/products/`)) {
    storefrontHits.push(u);
    const handle = u.slice(`${STORE}/products/`.length).replace(/\.js$/, "");
    return storefront[handle] ? json(storefront[handle]) : json({ error: "not found" }, 404);
  }
  const parsed = init?.body ? JSON.parse(init.body) : {};
  if (u.includes("/marketing-rpc/createEmailTemplate")) {
    captured.push(parsed.input);
    return json({ output: { _id: "aaaaaaaaaaaaaaaaaaaaaaaa" } });
  }
  if (u.includes("/marketing-rpc/createProductFilter")) {
    filterCreates++;
    return json({ output: { productFilterId: "bbbbbbbbbbbbbbbbbbbbbbbb" } });
  }
  throw new Error(`smoke fetch: unexpected URL ${u}`);
};

const grid = (pending: { name: string; url?: string }[]) => ({
  type: "interactive-cart",
  blockId: "grid",
  numberOfProducts: pending.length,
  productSelectionType: "static",
  manuallySelectedProducts: [],
  provider: "shopify",
  _pendingProducts: pending,
});

const events: ImportProgressEvent[] = [];
const options: ImportOptions = {
  jwt: "stub.jwt.token",
  serverBase: "https://stub.local",
  onProgress: (e: ImportProgressEvent) => {
    events.push(e);
  },
};

// ─── Mixed grid: two resolvable links, one variant pin, one dead link, one no link ───
await importTemplateRpc(
  {
    name: "Welcome (smoke)",
    sections: [
      grid([
        { name: "Morality T-Shirt", url: `${STORE}/products/morality-t-shirt` },
        { name: "Mayhem T-Shirt", url: `${STORE}/products/mayhem-t-shirt?variant=2002` },
        { name: "Sold Out Hoodie", url: `${STORE}/products/sold-out-hoodie` },
        { name: "Retired Tee", url: `${STORE}/products/retired-tee` },
        { name: "Unlinked Tee" },
      ]),
    ],
  },
  options,
);

const block = captured[0].sections[0];
assert(block.productSelectionType === "static", `grid stays static (got ${block.productSelectionType})`);
assert(!("_pendingProducts" in block), "_pendingProducts stripped");
assert(!("recommendedProductFilterId" in block), "no best-sellers filter attached when products resolve");
assert(
  JSON.stringify(block.manuallySelectedProducts) ===
    JSON.stringify([
      { productId: "7488897679427", variantId: "1002" },
      { productId: "7488897679428", variantId: "2002" },
      { productId: "7488897679429", variantId: "3001" },
    ]),
  `numeric string ids; first available variant, ?variant= honoured, first variant when none available — got ${JSON.stringify(block.manuallySelectedProducts)}`,
);
assert(block.numberOfProducts === 3, `numberOfProducts trimmed to the pinned count (got ${block.numberOfProducts})`);

const resolvedEv = events.find((e) => e.kind === "static_products_resolved") as any;
assert(
  resolvedEv &&
    resolvedEv.resolved.join("|") === "Morality T-Shirt|Mayhem T-Shirt|Sold Out Hoodie" &&
    resolvedEv.unresolved.join("|") === "Retired Tee|Unlinked Tee",
  `static_products_resolved names resolved + unresolved, got ${JSON.stringify(resolvedEv)}`,
);
assert(!events.some((e) => e.kind === "static_products_fallback"), "no fallback event when products resolve");
assert(filterCreates === 0, "no product filter created for a resolved grid");
assert(
  storefrontHits.every((h) => h.endsWith(".js")) && !storefrontHits.some((h) => h.includes("?variant=")),
  `storefront fetched as /products/<handle>.js without the query string, got ${storefrontHits.join(", ")}`,
);

// ─── Same product in a second template of the run: served from the cache ───
const hitsBefore = storefrontHits.length;
await importTemplateRpc(
  {
    name: "Welcome 2 (smoke)",
    sections: [grid([{ name: "Morality T-Shirt", url: `${STORE}/products/morality-t-shirt` }])],
  },
  options,
);
assert(storefrontHits.length === hitsBefore, "repeat product URL in the same run is not re-fetched");
assert(
  captured[1].sections[0].manuallySelectedProducts?.[0]?.productId === "7488897679427",
  "cached lookup still pins the product",
);

// ─── Nothing resolves: best-sellers fallback keeps the block visible ───
await importTemplateRpc(
  {
    name: "Welcome 3 (smoke)",
    sections: [grid([{ name: "Retired Tee", url: `${STORE}/products/retired-tee` }, { name: "Unlinked Tee" }])],
  },
  options,
);
const fallback = captured[2].sections[0];
assert(fallback.productSelectionType === "dynamic", "all-unresolved grid falls back to dynamic");
assert(fallback.recommendedProductFilterId === "bbbbbbbbbbbbbbbbbbbbbbbb", "fallback attaches the best-sellers filter");
const fallbackEv = events.find((e) => e.kind === "static_products_fallback") as any;
assert(
  fallbackEv && fallbackEv.products.join("|") === "Retired Tee|Unlinked Tee",
  `static_products_fallback lists every product, got ${JSON.stringify(fallbackEv)}`,
);

if (failures) {
  console.error(`static-products-resolve.smoke.ts: ${failures} failure(s)`);
  process.exit(1);
}
console.log("static-products-resolve.smoke.ts: all assertions passed");

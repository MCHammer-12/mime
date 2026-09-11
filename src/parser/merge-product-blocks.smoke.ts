/**
 * Smoke test for mergeAdjacentProductBlocks.
 *
 *   npx tsx src/parser/merge-product-blocks.smoke.ts
 *
 * Static grids of the same shape merge (Klaviyo merchants stack hand-picked
 * rows). Dynamic blocks of the SAME feed are per-column duplicates — a
 * multi-column Klaviyo product row emits one block per column, each
 * hydrating the full feed at send time (White Elm AC grids rendered every
 * grid twice) — so they collapse to the first. Dynamic blocks of different
 * feeds (different filter, recommendedProductFilterId or schemaFieldName)
 * never merge.
 */
import { mergeAdjacentProductBlocks } from "./index.js";
import { EmailBlockType } from "../renderer/types.js";
import { TRIGGER_PRODUCTS_FILTER_ID } from "./blocks/product.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const CART = { name: "Cart Item", productRecommendationType: "products_added_to_cart" };
const BEST = { name: "Best Sellers", productRecommendationType: "best_sellers" };

// Fresh object per call — the merge must key on JSON equality, not
// reference identity (parser emissions share module constants, but that's
// an implementation detail this test deliberately doesn't rely on).
const dyn = (filter: object, schemaFieldName?: string): any => ({
  type: EmailBlockType.PRODUCTS,
  productSelectionType: "dynamic",
  columns: 2,
  ...(schemaFieldName ? { schemaFieldName } : {}),
  _pendingFilter: JSON.parse(JSON.stringify(filter)),
});
// Cart/browse cards: no `_pendingFilter`, the trigger-products sentinel
// carried directly on the block.
const trig = (schemaFieldName?: string): any => ({
  type: EmailBlockType.PRODUCTS,
  productSelectionType: "dynamic",
  columns: 2,
  ...(schemaFieldName ? { schemaFieldName } : {}),
  recommendedProductFilterId: TRIGGER_PRODUCTS_FILTER_ID,
});
const spacer = (): any => ({ type: EmailBlockType.SPACER });
const stat = (names: string[]): any => ({
  type: EmailBlockType.PRODUCTS,
  productSelectionType: "static",
  columns: 2,
  numberOfProducts: names.length,
  _pendingProducts: names.map((name) => ({ name })),
});

// adjacent same-feed dynamic duplicates → collapsed to the first
{
  const out = mergeAdjacentProductBlocks([dyn(CART, "cartContext"), dyn(CART, "cartContext")]);
  if (out.length !== 1) fail(`adjacent dynamic duplicates: expected 1 block, got ${out.length}`);
  console.log("✓ adjacent same-feed dynamic duplicates collapse to one");
}

// same-feed duplicates separated by a spacer → collapsed, spacer dropped
{
  const out = mergeAdjacentProductBlocks([
    dyn(CART, "cartContext"),
    spacer(),
    dyn(CART, "cartContext"),
  ]);
  if (out.length !== 1) fail(`spacer-separated duplicates: expected 1 block, got ${out.length}`);
  console.log("✓ spacer-separated same-feed duplicates collapse, spacer dropped");
}

// different feeds (cart vs best sellers) → NOT merged
{
  const out = mergeAdjacentProductBlocks([dyn(CART, "cartContext"), dyn(BEST)]);
  if (out.length !== 2) fail(`different feeds: expected 2 blocks, got ${out.length}`);
  console.log("✓ different feeds stay separate");
}

// same filter but different schemaFieldName → NOT merged
{
  const out = mergeAdjacentProductBlocks([dyn(CART, "cartContext"), dyn(CART)]);
  if (out.length !== 2) fail(`schemaFieldName mismatch: expected 2 blocks, got ${out.length}`);
  console.log("✓ schemaFieldName mismatch blocks the merge");
}

// trigger-products duplicates (per-column cart cards) → collapsed to the first
{
  const out = mergeAdjacentProductBlocks([
    trig("cartContext"),
    spacer(),
    trig("cartContext"),
  ]);
  if (out.length !== 1) fail(`trigger-products duplicates: expected 1 block, got ${out.length}`);
  const b: any = out[0];
  if (b.recommendedProductFilterId !== TRIGGER_PRODUCTS_FILTER_ID || "_pendingFilter" in b)
    fail(`trigger-products merge lost the sentinel: ${JSON.stringify(b)}`);
  console.log("✓ trigger-products duplicates collapse and keep the sentinel");
}

// trigger products vs a Best Sellers feed → NOT merged
{
  const out = mergeAdjacentProductBlocks([trig("cartContext"), dyn(BEST)]);
  if (out.length !== 2) fail(`sentinel vs filter: expected 2 blocks, got ${out.length}`);
  console.log("✓ trigger products and a filter feed stay separate");
}

// non-decorative block between duplicates breaks the chain
{
  const text: any = { type: EmailBlockType.TEXT, text: "shop these" };
  const out = mergeAdjacentProductBlocks([dyn(CART, "cartContext"), text, dyn(CART, "cartContext")]);
  if (out.length !== 3) fail(`text between duplicates: expected 3 blocks, got ${out.length}`);
  console.log("✓ text between dynamic blocks breaks the chain");
}

// static merge regression: dedupe by name, count updated, spacer dropped
{
  const out = mergeAdjacentProductBlocks([stat(["Alpha", "Beta"]), spacer(), stat(["beta", "Gamma"])]);
  if (out.length !== 1) fail(`static merge: expected 1 block, got ${out.length}`);
  const b: any = out[0];
  if (b.numberOfProducts !== 3 || b._pendingProducts.length !== 3)
    fail(`static merge: expected 3 deduped products, got ${JSON.stringify(b._pendingProducts)}`);
  console.log("✓ static merge still dedupes by name and updates the count");
}

console.log("\nAll merge-product-blocks smoke checks passed.");

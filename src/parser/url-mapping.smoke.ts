/**
 * Smoke test for url-mapping.ts. Locks in the post-2026-05-08 behavior:
 *
 *   - Klaviyo checkout-URL variables ({{ event.URL }} etc.) get rewritten
 *     to `<storeUrl>/cart` when storeUrl is present.
 *   - Without a storeUrl, the variable stays and a reviewItem is pushed.
 *   - Static URLs pass through unchanged.
 *
 *   npx tsx src/parser/url-mapping.smoke.ts
 */
import {
  classifyKlaviyoUrl,
  isKlaviyoCheckoutUrlVariable,
  mapKlaviyoLink,
} from "./url-mapping.js";
import type { ParseContext } from "./index.js";
import { EmailBlockType } from "../renderer/types.js";

function emptyCtx(storeUrl: string | null = null): ParseContext {
  return {
    warnings: [],
    unsupportedFeatures: [],
    reviewItems: [],
    skippedBlocks: [],
    storeUrl,
  };
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// ─── isKlaviyoCheckoutUrlVariable ─────────────────────────────────────────

assert(isKlaviyoCheckoutUrlVariable("{{ event.URL }}"), "event.URL detected");
assert(
  isKlaviyoCheckoutUrlVariable("{{ event.CheckoutURL }}"),
  "event.CheckoutURL detected",
);
assert(
  isKlaviyoCheckoutUrlVariable("{{ event.extra.checkout_url }}"),
  "event.extra.checkout_url detected",
);
assert(
  isKlaviyoCheckoutUrlVariable("{{ event.extra.responsive_checkout_url }}"),
  "event.extra.responsive_checkout_url detected",
);
assert(
  isKlaviyoCheckoutUrlVariable("{{ event.URL|default:'' }}"),
  "Liquid filter suffix tolerated",
);
assert(
  !isKlaviyoCheckoutUrlVariable("https://example.com/cart"),
  "static URL not detected",
);
assert(
  !isKlaviyoCheckoutUrlVariable("{{ event.something_else }}"),
  "non-checkout var not detected",
);

// ─── mapKlaviyoLink with storeUrl ─────────────────────────────────────────

const withStore = mapKlaviyoLink("{{ event.URL }}", "https://defiancebeauty.com");
assert(withStore.linkType === "web-page", "linkType is web-page");
assert(
  withStore.buttonLink === "https://defiancebeauty.com/cart",
  `buttonLink is brand /cart, got ${withStore.buttonLink}`,
);

// Trailing slash on storeUrl shouldn't double up. ParseContext normalizes
// before storing, so this asserts the raw mapping behavior with a
// pre-normalized URL.
const noTrailing = mapKlaviyoLink("{{ event.CheckoutURL }}", "https://store.com");
assert(
  noTrailing.buttonLink === "https://store.com/cart",
  `no trailing slash: ${noTrailing.buttonLink}`,
);

// ─── mapKlaviyoLink without storeUrl ──────────────────────────────────────

const noStore = mapKlaviyoLink("{{ event.URL }}", null);
assert(noStore.linkType === "web-page", "no-store: linkType is web-page");
assert(
  noStore.buttonLink === "{{ event.URL }}",
  `no-store: variable stays, got ${noStore.buttonLink}`,
);

// ─── Static URL passthrough ───────────────────────────────────────────────

const staticUrl = mapKlaviyoLink(
  "https://example.com/products/foo",
  "https://store.com",
);
assert(
  staticUrl.buttonLink === "https://example.com/products/foo",
  "static URL passes through unchanged",
);

// ─── classifyKlaviyoUrl pushes reviewItem when no storeUrl ────────────────

const ctx1 = emptyCtx(null);
const c1 = classifyKlaviyoUrl("{{ event.URL }}", EmailBlockType.BUTTON, ctx1);
assert(c1.linkType === "web-page", "classify: linkType web-page");
assert(
  c1.buttonLink === "{{ event.URL }}",
  "classify: variable stays without storeUrl",
);
assert(
  ctx1.reviewItems.length === 1,
  `classify no-storeUrl: 1 reviewItem, got ${ctx1.reviewItems.length}`,
);

// ─── classifyKlaviyoUrl: no reviewItem when rewritten to /cart ────────────

const ctx2 = emptyCtx("https://defiancebeauty.com");
const c2 = classifyKlaviyoUrl("{{ event.URL }}", EmailBlockType.BUTTON, ctx2);
assert(
  c2.buttonLink === "https://defiancebeauty.com/cart",
  "classify: rewritten",
);
assert(
  ctx2.reviewItems.length === 0,
  "classify: no reviewItem after rewrite",
);

console.log("✓ url-mapping smoke tests pass");

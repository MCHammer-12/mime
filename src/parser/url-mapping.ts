/**
 * Maps Klaviyo template variables in URLs to Redo dynamic variable schema fields.
 *
 * Klaviyo emails use Jinja-like variables (e.g., `{{ event.URL }}`) that resolve
 * at send time based on the flow trigger. Redo's equivalent is a dynamic variable
 * via `linkType: "dynamic-variable"` + `schemaFieldName`, resolved from
 * `renderContext.schemaInstance[schemaFieldName]` at render time.
 *
 * Also handles three-state classification for any URL-carrying block:
 * - Known-mapped → passes as dynamic-variable
 * - Explicitly unsupported → ctx.unsupportedFeatures (blocks template)
 * - Unknown variable → ctx.reviewItems (non-blocking, user classifies later)
 */

import type { EmailBlockType } from "../renderer/types.js";
import type { ParseContext } from "./index.js";

// MappedLink used to include a `dynamic-variable` variant. We removed it
// after Redo eng confirmed that schemaInstance.checkoutUrl resolves to a
// Storefront cart URL that is silently null on cart-fetch failure. See
// mapKlaviyoLink doc for context.
export type MappedLink = { linkType: "web-page"; buttonLink: string };

const CHECKOUT_URL_PATTERNS: RegExp[] = [
  // {{ event.URL }} — abandoned cart / abandoned checkout default
  // (optional Liquid filter suffix, e.g. `|default:''`)
  /^\s*\{\{\s*event\.URL\s*(\|[^}]*)?\s*\}\}\s*$/,
  // {{ event.CheckoutURL }} (optional Liquid filter)
  /^\s*\{\{\s*event\.CheckoutURL\s*(\|[^}]*)?\s*\}\}\s*$/,
  // {{ event.extra.checkout_url }} (optional Liquid filter)
  /^\s*\{\{\s*event\.extra\.checkout_url\s*(\|[^}]*)?\s*\}\}\s*$/,
  // {{ event.extra.responsive_checkout_url }} — Klaviyo Shopify
  // abandoned-checkout responsive variant. Same destination as
  // event.URL when the abandonment fires.
  /^\s*\{\{\s*event\.extra\.responsive_checkout_url\s*(\|[^}]*)?\s*\}\}\s*$/,
];

export const KLAVIYO_VAR_RE = /\{\{[^}]+\}\}|\{%[^%]+%\}/;

/**
 * Variables Redo can't resolve. Any URL whose variable name matches one of
 * these patterns blocks the template (routed to manual migration).
 */
export const UNSUPPORTED_VARIABLES: { pattern: RegExp; reason: string }[] = [
  { pattern: /^gift_card\./i, reason: "gift_card" },
  { pattern: /^customer\.reset_password_url$/i, reason: "customer.reset_password_url" },
  { pattern: /^customer\.account_activation_url$/i, reason: "customer.account_activation_url" },
  { pattern: /^fulfillment\.tracking_urls?/i, reason: "fulfillment.tracking_url(s)" },
  { pattern: /^tracking_url$/i, reason: "tracking_url" },
];

export function extractVariableName(href: string): string {
  const m = href.match(/\{\{\s*([^}|\s]+)/);
  return m ? m[1] : href;
}

export function classifyVariable(varName: string): "unsupported" | "review" {
  for (const { pattern } of UNSUPPORTED_VARIABLES) {
    if (pattern.test(varName)) return "unsupported";
  }
  return "review";
}

/** True if the href is one of the Klaviyo abandoned-cart/checkout URL
 *  variables — `event.URL`, `event.CheckoutURL`, `event.extra.checkout_url`,
 *  `event.extra.responsive_checkout_url` (each with optional Liquid filter). */
export function isKlaviyoCheckoutUrlVariable(url: string): boolean {
  if (!url) return false;
  return CHECKOUT_URL_PATTERNS.some((p) => p.test(url));
}

/**
 * Maps a raw Klaviyo href to a web-page link. For Klaviyo's checkout-URL
 * variables (`{{ event.URL }}` etc.), substitutes a static `<storeUrl>/cart`
 * when the merchant's storeUrl is known.
 *
 * Background: we used to emit `{ linkType: "dynamic-variable",
 * schemaFieldName: "checkoutUrl" }`, banking on Redo's runtime to populate
 * the field at send time. Redo eng confirmed (2026-05-08) that
 * `schemaInstance.checkoutUrl` is a Shopify Storefront cart URL that is
 * silently `null` when the cart fetch fails (no Storefront access token,
 * non-Shopify provider, fetch error). A null dynamic var causes the
 * button block to be hidden entirely (button.tsx hideBlock=true), so a
 * generic `/cart` link is strictly better than the dynamic-variable
 * approach for migrated emails.
 *
 * If `storeUrl` is null/empty, we leave the original Klaviyo variable in
 * the href and let `classifyKlaviyoUrl` push a reviewItem so the operator
 * can fix it manually.
 */
export function mapKlaviyoLink(
  url: string,
  storeUrl: string | null | undefined,
): MappedLink {
  if (isKlaviyoCheckoutUrlVariable(url)) {
    if (storeUrl) {
      return { linkType: "web-page", buttonLink: `${storeUrl}/cart` };
    }
    // No store URL → leave variable as-is; classifyKlaviyoUrl flags it.
  }
  return { linkType: "web-page", buttonLink: url };
}

/**
 * Map + classify a Klaviyo URL in one call. Pushes unsupported/review entries
 * to ctx as appropriate. Returns the MappedLink so the caller can use it for
 * link fields on the emitted block.
 */
export function classifyKlaviyoUrl(
  url: string,
  blockType: EmailBlockType,
  ctx: ParseContext,
): MappedLink {
  const mapped = mapKlaviyoLink(url, ctx.storeUrl);
  if (mapped.linkType === "web-page" && KLAVIYO_VAR_RE.test(mapped.buttonLink)) {
    const varName = extractVariableName(mapped.buttonLink);
    const kind = classifyVariable(varName);
    if (kind === "unsupported") {
      ctx.unsupportedFeatures.push({
        blockType,
        reason: varName,
        context: mapped.buttonLink,
      });
    } else {
      ctx.reviewItems.push({
        blockType,
        variableName: varName,
        context: mapped.buttonLink,
      });
    }
  }
  return mapped;
}

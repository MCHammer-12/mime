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

export type MappedLink =
  | { linkType: "dynamic-variable"; schemaFieldName: string }
  | { linkType: "web-page"; buttonLink: string };

const CHECKOUT_URL_PATTERNS: RegExp[] = [
  // {{ event.URL }} — abandoned cart / abandoned checkout default
  // (optional Liquid filter suffix, e.g. `|default:''`)
  /^\s*\{\{\s*event\.URL\s*(\|[^}]*)?\s*\}\}\s*$/,
  // {{ event.CheckoutURL }} (optional Liquid filter)
  /^\s*\{\{\s*event\.CheckoutURL\s*(\|[^}]*)?\s*\}\}\s*$/,
  // {{ event.extra.checkout_url }} (optional Liquid filter)
  /^\s*\{\{\s*event\.extra\.checkout_url\s*(\|[^}]*)?\s*\}\}\s*$/,
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

/**
 * Returns the Redo schema field name a Klaviyo URL should map to, or null
 * if the URL is a static link (or an unrecognized variable).
 */
export function mapKlaviyoUrlToSchemaField(url: string): string | null {
  if (!url) return null;
  if (CHECKOUT_URL_PATTERNS.some((p) => p.test(url))) {
    return "checkoutUrl";
  }
  return null;
}

/**
 * Maps a raw Klaviyo href to either a dynamic-variable link spec or a web-page
 * link. Call this from block parsers (button, image clickthrough, etc.) to
 * produce the correct Redo link shape.
 */
export function mapKlaviyoLink(url: string): MappedLink {
  const schemaFieldName = mapKlaviyoUrlToSchemaField(url);
  if (schemaFieldName) {
    return { linkType: "dynamic-variable", schemaFieldName };
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
  const mapped = mapKlaviyoLink(url);
  if (mapped.linkType === "web-page" && KLAVIYO_VAR_RE.test(url)) {
    const varName = extractVariableName(url);
    const kind = classifyVariable(varName);
    if (kind === "unsupported") {
      ctx.unsupportedFeatures.push({
        blockType,
        reason: varName,
        context: url,
      });
    } else {
      ctx.reviewItems.push({
        blockType,
        variableName: varName,
        context: url,
      });
    }
  }
  return mapped;
}

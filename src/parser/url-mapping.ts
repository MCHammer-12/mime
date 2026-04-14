/**
 * Maps Klaviyo template variables in URLs to Redo dynamic variable schema fields.
 *
 * Klaviyo emails use Jinja-like variables (e.g., `{{ event.URL }}`) that resolve
 * at send time based on the flow trigger. Redo's equivalent is a dynamic variable
 * via `linkType: "dynamic-variable"` + `schemaFieldName`, resolved from
 * `renderContext.schemaInstance[schemaFieldName]` at render time.
 */

export type MappedLink =
  | { linkType: "dynamic-variable"; schemaFieldName: string }
  | { linkType: "web-page"; buttonLink: string };

const CHECKOUT_URL_PATTERNS: RegExp[] = [
  // {{ event.URL }} — abandoned cart / abandoned checkout default
  /^\s*\{\{\s*event\.URL\s*\}\}\s*$/,
  // {{ event.CheckoutURL }}
  /^\s*\{\{\s*event\.CheckoutURL\s*\}\}\s*$/,
  // {{ event.extra.checkout_url }} (optionally with |default:'' or similar filters)
  /^\s*\{\{\s*event\.extra\.checkout_url\s*(\|[^}]*)?\s*\}\}\s*$/,
];

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

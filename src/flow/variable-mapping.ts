import { SchemaType, type ParseWarning } from "./types.js";
import { formatAddress, type KlaviyoAccount } from "../fetch-account.js";

// Klaviyo Liquid variable path → Redo schema-instance field name.
// Redo auto-snake-cases schema fields before Liquid render, so both
// {{ customer.email }} and {{ customer_email }} resolve identically.
// We emit snake_case for clarity and consistency.
//
// Source: redo/model/src/advanced-flow/schemas/marketing/marketing.ts
// (exposed schema-instance fields for the Marketing trigger schemas).
export const KLAVIYO_TO_REDO_VAR_MAP: Record<string, string> = {
  // Profile / customer fields
  "person.email":        "customer_email",
  "person.first_name":   "customer_first_name",
  "person.last_name":    "customer_last_name",
  "person.full_name":    "customer_full_name",
  "person.phone":        "customer_phone",
  "person.phone_number": "customer_phone",
  "person.id":           "redo_customer_id",

  // Klaviyo's older dialect lets a template say {{ first_name }} for the same
  // profile field as {{ person.first_name }}. It isn't namespaced, so the
  // rewriter used to pass it through verbatim — and Redo's validator rejects
  // it on every trigger, taking the whole flow import with it (Any Means
  // Necessary 2026-09-09: three flows died on one {{ first_name }} in an SMS).
  // Probed against live createSmsTemplate: customer_first_name and
  // customer_last_name are accepted on sms_marketing_signup,
  // marketing_cart_abandonment, marketing_browse_abandonment,
  // email_marketing_signup, marketing_back_in_stock and order_tracking, so
  // these belong in the base map rather than a per-schema overlay.
  "first_name":          "customer_first_name",
  "last_name":           "customer_last_name",

  // Already a valid Redo field on every marketing schema except
  // SMS_MARKETING_SIGNUP (which drops it below — an SMS sign-up flow opts out
  // via STOP, not a link). Mapped to itself so the rewriter recognises it
  // instead of reporting it as dropped on nearly every template.
  "unsubscribe_link":    "unsubscribe_link",

  // Event-specific fields — most relevant for abandonment triggers
  "event.checkout_url":              "checkout_url",
  "event.responsive_checkout_url":   "checkout_url",
  "event.extra.responsive_checkout_url": "checkout_url",
  "event.extra.checkout_url":        "checkout_url",
  "event.timestamp":                 "time",
};

// Fields that only exist on some trigger schemas. Redo rejects a template whose
// tokens reference fields the flow's trigger doesn't provide, so these can't go
// in the base map — mapping event.URL globally would swap one rejected token for
// another on every non-browse flow. Layered over KLAVIYO_TO_REDO_VAR_MAP when
// the caller knows the schemaType.
//
// Source: redo/flows/common/src/schemas/marketing/marketing.ts —
// baseMarketingBrowseAbandonmentSchema and its CS twin both expose
// `browsedPageUrl: Maybe Url` ("The URL of the page the customer was browsing"),
// which is exactly Klaviyo's Viewed Product / Active on Site `event.URL`.
// A `null` value means "drop this token on this schema": it is a valid Redo
// field elsewhere, so it lives in the base map, but this trigger doesn't
// provide it and passing it through would 400 the template.
const SCHEMA_VAR_MAP: Partial<Record<SchemaType, Record<string, string | null>>> = {
  // SMS sign-up carries no unsubscribe link — the opt-out is a STOP reply, and
  // the trigger doesn't expose the field (verified: createSmsTemplate rejects
  // unsubscribe_link, customer_email, customer_phone and store_url here).
  [SchemaType.SMS_MARKETING_SIGNUP]: {
    "unsubscribe_link": null,
  },
  [SchemaType.MARKETING_BROWSE_ABANDONMENT]: {
    "event.URL": "browsed_page_url",
  },
  [SchemaType.MARKETING_COMMENTSOLD_BROWSE_ABANDONMENT]: {
    "event.URL": "browsed_page_url",
  },
  // Cart-abandonment SMS in Klaviyo links back with `{{ event.URL }}` — for
  // the Added to Cart metric that URL *is* the cart/checkout link. Redo's cart
  // abandonment trigger exposes it as `checkoutUrl` (verified: createSmsTemplate
  // accepts checkout_url / store_url on marketing_cart_abandonment, rejects
  // browsed_page_url / product_url).
  [SchemaType.MARKETING_CART_ABANDONMENT]: {
    "event.URL": "checkout_url",
  },
  [SchemaType.MARKETING_COMMENTSOLD_CART_ABANDONMENT]: {
    "event.URL": "checkout_url",
  },
  // Klaviyo back-in-stock templates fetch the item with {% catalog %} and read
  // `catalog_item.*` inside the block. baseMarketingBackInStockSchema exposes
  // the same data flattened (backInStockProductUrl/Title) plus
  // `restockedProduct: Maybe Trigger Product` for the image.
  [SchemaType.MARKETING_BACK_IN_STOCK]: {
    "catalog_item.url":   "back_in_stock_product_url",
    "catalog_item.title": "back_in_stock_product_title",
    "catalog_item.variant.featured_image.full.src": "restocked_product.image_url",
  },
  // Klaviyo's price-drop event fields → baseMarketingPriceDropSchema
  // (redo/flows/common/src/schemas/marketing/marketing.ts). The schema also
  // exposes `discountedProduct: Maybe Trigger Product` with .url/.image_url
  // (product-variables.ts documents that dotted usage), which covers the
  // image and clickthrough tokens the flattened fields don't.
  [SchemaType.MARKETING_PRICE_DROP]: {
    "event.product_name":      "product_title",
    "event.original_price":    "formatted_previous_price",
    "event.reduced_price":     "formatted_current_price",
    "event.price_drop_amount": "formatted_savings",
    "event.price_drop_percent": "formatted_price_drop_percentage",
    "event.image_url":         "discounted_product.image_url",
    "event.url":               "discounted_product.url",
  },
};

// Klaviyo `organization.*` tokens are merchant constants (name, site URL,
// mailing address), not per-send data. No Redo trigger schema exposes an
// `organization` object, so a passed-through token gets the whole template
// rejected by createSmsTemplate / createEmailTemplate. Resolve them to
// literals at parse time instead — the same treatment src/transform.ts
// already gives them on the email-template path.
function resolveOrgToken(varPath: string, account: KlaviyoAccount): string | null {
  switch (varPath) {
    case "organization.name":           return account.organizationName;
    case "organization.url":
    case "organization.website":
    case "organization.website_url":    return account.websiteUrl;
    case "organization.full_address":   return formatAddress(account);
    case "organization.street_address":
    case "organization.address1":       return account.address.street;
    case "organization.city":           return account.address.city;
    case "organization.region":         return account.address.region;
    case "organization.zip":            return account.address.zip;
    case "organization.country":        return account.address.country;
    default:                            return null;
  }
}

// Roots that are Klaviyo's own namespaces. Anything under them that we can't
// map is guaranteed to be rejected by Redo's template validator, so leaving it
// verbatim costs the entire flow import. Drop to empty + warn instead: the flow
// lands and the operator gets a breadcrumb. Tokens outside these roots are left
// alone — they may already be valid Redo variables. `today` is Klaviyo's date
// global (bound by its `{% today %}` tag); Redo's validator rejects it on any
// trigger, so it drops like a namespace (White Elm 2026-09-04).
const KLAVIYO_ROOTS = ["person", "event", "organization", "catalog_item", "today"];

// Matches any Klaviyo root used as a word inside a Liquid tag or filter chain.
// Built from KLAVIYO_ROOTS so a root added above is covered everywhere — the
// old hand-written tag regex missed catalog_item and let
// `{% currency_format catalog_item.metadata.price %}` reach the recipient as
// literal text (Bronco Western 2026-09-02).
const KLAVIYO_ROOT_RE = new RegExp(`\\b(${KLAVIYO_ROOTS.join("|")})\\b`);

// Liquid tags that structure the document. A Klaviyo-only *output* tag
// (`{% currency_format %}`) can be dropped on sight; dropping a control tag
// would orphan its closer, so those are flagged and left in place.
const LIQUID_CONTROL_TAGS = new Set([
  "if", "unless", "elsif", "else", "endif", "endunless",
  "for", "endfor", "break", "continue",
  "case", "when", "endcase",
  "assign", "capture", "endcapture", "comment", "endcomment", "raw", "endraw",
]);

// Klaviyo-only paired tags, dropped on sight. {% catalog %} binds catalog_item
// inside its block; the opener carries the event reference but the closer
// doesn't, so without this the closer leaks as literal text into the email.
const KLAVIYO_ONLY_TAGS = new Set(["catalog", "endcatalog"]);

function isKlaviyoNamespaced(varPath: string): boolean {
  return KLAVIYO_ROOTS.some((r) => varPath === r || varPath.startsWith(`${r}.`));
}

// A mapped variable keeps its filter chain, but a filter *argument* can itself
// reference a Klaviyo root (`|default:catalog_item.featured_image.full.src`),
// which Redo leaves in the rendered email as literal text. Drop just those
// segments and keep the rest of the chain (Bronco Western 2026-09-02).
function scrubKlaviyoFilters(filters: string): string {
  if (!filters || !KLAVIYO_ROOT_RE.test(filters)) return filters;
  const kept = filters
    .split("|")
    .slice(1)
    .filter((seg) => !KLAVIYO_ROOT_RE.test(seg));
  return kept.length ? `|${kept.join("|")}` : "";
}

interface LiquidToken {
  full: string;        // "{{ person.email|default:'' }}"
  varPath: string;     // "person.email"
  filters: string;     // "|default:''"
}

// Parse the inside of a `{{ ... }}` tag into variable path + filter chain.
// Returns null if the structure is exotic (e.g. {% ... %} wasn't a variable).
function parseLiquidVar(inside: string): { varPath: string; filters: string } | null {
  const pipeIndex = inside.indexOf("|");
  const varPath = (pipeIndex === -1 ? inside : inside.slice(0, pipeIndex)).trim();
  const filters = pipeIndex === -1 ? "" : inside.slice(pipeIndex);
  if (!varPath) return null;
  return { varPath, filters };
}

// Rewrite Klaviyo Liquid tokens (`{{ person.email|default:'' }}`) to Redo
// equivalents (`{{ customer_email|default:'' }}`). Preserves filter chains
// and non-variable Liquid tags (`{% if %}`, `{% for %}`) verbatim — both
// sides are LiquidJS so those translate identically.
//
// Returns { output, unmappedTokens } where unmapped tokens are varPaths
// not in the map. Caller decides whether to skip the webhook based on count.
// Klaviyo's price-drop event fields are bare numbers, so templates supply the
// symbol and number-formatting themselves: "${{ … }}", "{{ … }}%",
// |floatformat:2. The Redo formatted_* fields they map to are strings that
// already carry the symbol — left alone the literal doubles ("$$71.99",
// "20%% off") and floatformat breaks on the non-number (Bronco price-drop
// email). Fold the now-redundant literals and filters into the token.
function dedupeFormattedSymbols(s: string): string {
  return s
    .replace(/(\{\{\s*formatted_[a-z_]*percentage[^}]*\}\})\s*%/gi, "$1")
    .replace(/\$\s*(\{\{\s*formatted_[a-z_]*(?:price|savings)[^}]*\}\})/gi, "$1")
    .replace(/(\{\{\s*formatted_[a-z_]+[^}]*?)\s*\|\s*floatformat(?::\d+)?/gi, "$1");
}

export function rewriteKlaviyoLiquid(
  input: string,
  warnings: ParseWarning[],
  actionId: string,
  schemaType?: SchemaType,
  account?: KlaviyoAccount | null,
): { output: string; unmappedTokens: string[] } {
  if (!input) return { output: input, unmappedTokens: [] };

  const varMap = {
    ...KLAVIYO_TO_REDO_VAR_MAP,
    ...(schemaType ? SCHEMA_VAR_MAP[schemaType] : undefined),
  };
  const unmappedTokens: string[] = [];
  const output = input.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full, inside: string) => {
    const parsed = parseLiquidVar(inside);
    if (!parsed) return full;

    // Klaviyo's `person|lookup:"first_name"` syntax is equivalent to
    // `person.first_name` — they're how Klaviyo's older Liquid dialect
    // accesses profile fields that aren't always present. Translate by
    // stripping the lookup filter and routing through the standard
    // person.X map; preserve any remaining filters (default, upcase, etc.).
    // Both `lookup:"X"` and `lookup:"$X"` (legacy $-prefixed) are seen.
    if (parsed.varPath === "person" || parsed.varPath === "event") {
      const lookupMatch = parsed.filters.match(
        /^\s*\|\s*lookup\s*:\s*["']\$?([\w.]+)["']/,
      );
      if (lookupMatch) {
        const field = lookupMatch[1]!;
        const remaining = parsed.filters.slice(lookupMatch[0].length);
        const mapped = varMap[`${parsed.varPath}.${field}`];
        if (mapped) {
          return `{{ ${mapped}${scrubKlaviyoFilters(remaining)} }}`;
        }
        // Lookup target we don't recognize — keep current "drop to empty
        // string + warn" behaviour so AI / event-specific properties
        // don't leak through unrendered.
        unmappedTokens.push(`${parsed.varPath}${parsed.filters}`);
        return '""';
      }
    }

    const mapped = varMap[parsed.varPath];
    if (mapped) {
      return `{{ ${mapped}${scrubKlaviyoFilters(parsed.filters)} }}`;
    }
    // Explicitly dropped on this schema (see SCHEMA_VAR_MAP): valid Redo field,
    // just not one this trigger provides. Empty + warn, same as a namespaced
    // token — passing it through would 400 the template.
    if (mapped === null) {
      unmappedTokens.push(parsed.varPath);
      return "";
    }

    // Merchant constants resolve to literals — filters are dropped along with
    // the token because there's nothing left to filter.
    if (account) {
      const literal = resolveOrgToken(parsed.varPath, account);
      if (literal) return literal;
    }

    // Inside `{% for i in event.Items %}` loops, `i.ProductID` etc. reference
    // loop variables, not schema instance fields. Redo doesn't expose
    // event.Items-style loops at all — the merchant must rebuild this.
    // Flag as unmapped either way (caller's token count will spike and the
    // whole webhook gets skipped via the enrichment heuristic).
    unmappedTokens.push(parsed.varPath);
    if (isKlaviyoNamespaced(parsed.varPath)) return "";
    // Kept verbatim — but a Klaviyo root in its filter args still never
    // resolves, so scrub those either way. Also makes a re-run over an
    // already-rewritten template converge instead of re-leaking.
    return `{{ ${parsed.varPath}${scrubKlaviyoFilters(parsed.filters)} }}`;
  });

  if (unmappedTokens.length > 0) {
    const uniq = [...new Set(unmappedTokens)];
    warnings.push({
      kind: "requires-review",
      actionId,
      message: `Liquid rewriter: ${unmappedTokens.length} unmapped token(s) in payload (${uniq.slice(0, 5).join(", ")}${uniq.length > 5 ? `, ...${uniq.length - 5} more` : ""})`,
    });
  }

  return { output: dedupeFormattedSymbols(output), unmappedTokens };
}

/**
 * Deep-walk a parsed email template and run every string field through the
 * same rewriter the SMS and webhook paths use.
 *
 * Klaviyo templates carry `{{ organization.url }}` on logo clickthroughs and
 * `{{ event.* }}` inside hand-rolled product cards (merchants who built a cart
 * row out of raw Liquid instead of Klaviyo's product block). Redo's
 * createEmailTemplate rejects the *whole template* on any token the flow's
 * trigger doesn't provide, so a single unhandled one costs the entire flow
 * import — the same failure mode createSmsTemplate has.
 *
 * Mutates `root` in place. Returns what couldn't be resolved so the caller can
 * put it in front of the operator.
 */
export function sanitizeTemplateLiquid(
  root: unknown,
  actionId: string,
  warnings: ParseWarning[],
  schemaType?: SchemaType,
  account?: KlaviyoAccount | null,
): { unmappedTokens: string[]; unresolvableTags: string[] } {
  const unmappedTokens: string[] = [];
  const unresolvableTags: string[] = [];
  // Per-string warnings would be one line per block; collect and summarise.
  const swallowed: ParseWarning[] = [];

  const rewrite = (s: string): string => {
    if (!s.includes("{{") && !s.includes("{%")) return s;
    // `{% currency_format event|lookup:'Price' %}` and friends are tag-form,
    // not variable-form, so the rewriter never sees them. Redo's validator
    // lets them through and then renders the tag as literal text. Drop the
    // output-style ones; leave control flow alone (stripping a `{% if %}`
    // would orphan its `{% endif %}`) and flag both kinds either way.
    // [\s\S]*? not [^%]*: a tag body may contain literal % (strftime formats —
    // `{% today '%Y-%m-%d' as today %}` was invisible to the old scan).
    let out = s;
    for (const m of s.matchAll(/\{%\s*(\w+)[\s\S]*?%\}/g)) {
      if (!KLAVIYO_ONLY_TAGS.has(m[1]!) && !KLAVIYO_ROOT_RE.test(m[0]))
        continue;
      unresolvableTags.push(m[0].trim());
      if (!LIQUID_CONTROL_TAGS.has(m[1]!)) out = out.split(m[0]).join("");
    }
    const r = rewriteKlaviyoLiquid(out, swallowed, actionId, schemaType, account);
    unmappedTokens.push(...r.unmappedTokens);
    return r.output;
  };

  const visit = (node: any): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        if (typeof v === "string") node[i] = rewrite(v);
        else visit(v);
      });
    } else if (node && typeof node === "object") {
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (typeof v === "string") node[k] = rewrite(v);
        else visit(v);
      }
    }
  };
  visit(root);

  const uniqTokens = [...new Set(unmappedTokens)];
  const uniqTags = [...new Set(unresolvableTags)];
  if (uniqTokens.length > 0 || uniqTags.length > 0) {
    warnings.push({
      kind: "requires-review",
      actionId,
      message:
        `Email template referenced Klaviyo data the "${schemaType}" trigger doesn't provide; ` +
        `dropped so the template imports (Redo rejects unknown tokens outright). ` +
        `Rebuild in the Redo editor — a hand-rolled product card usually maps to a products block. ` +
        `Dropped: ${[...uniqTokens, ...uniqTags].join(", ")}`,
    });
  }

  return { unmappedTokens: uniqTokens, unresolvableTags: uniqTags };
}

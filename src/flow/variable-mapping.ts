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
const SCHEMA_VAR_MAP: Partial<Record<SchemaType, Record<string, string>>> = {
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
// alone — they may already be valid Redo variables.
const KLAVIYO_ROOTS = ["person", "event", "organization"];

// Liquid tags that structure the document. A Klaviyo-only *output* tag
// (`{% currency_format %}`) can be dropped on sight; dropping a control tag
// would orphan its closer, so those are flagged and left in place.
const LIQUID_CONTROL_TAGS = new Set([
  "if", "unless", "elsif", "else", "endif", "endunless",
  "for", "endfor", "break", "continue",
  "case", "when", "endcase",
  "assign", "capture", "endcapture", "comment", "endcomment", "raw", "endraw",
]);

function isKlaviyoNamespaced(varPath: string): boolean {
  return KLAVIYO_ROOTS.some((r) => varPath === r || varPath.startsWith(`${r}.`));
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
          return `{{ ${mapped}${remaining} }}`;
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
      return `{{ ${mapped}${parsed.filters} }}`;
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
    return isKlaviyoNamespaced(parsed.varPath) ? "" : full;
  });

  if (unmappedTokens.length > 0) {
    const uniq = [...new Set(unmappedTokens)];
    warnings.push({
      kind: "requires-review",
      actionId,
      message: `Liquid rewriter: ${unmappedTokens.length} unmapped token(s) in payload (${uniq.slice(0, 5).join(", ")}${uniq.length > 5 ? `, ...${uniq.length - 5} more` : ""})`,
    });
  }

  return { output, unmappedTokens };
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
    let out = s;
    for (const m of s.matchAll(/\{%\s*(\w+)[^%]*%\}/g)) {
      if (!/\b(event|organization|person)\b/.test(m[0])) continue;
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

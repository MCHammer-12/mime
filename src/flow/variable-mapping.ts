import type { ParseWarning } from "./types.js";

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
): { output: string; unmappedTokens: string[] } {
  if (!input) return { output: input, unmappedTokens: [] };

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
        const mapped = KLAVIYO_TO_REDO_VAR_MAP[`${parsed.varPath}.${field}`];
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

    const mapped = KLAVIYO_TO_REDO_VAR_MAP[parsed.varPath];
    if (mapped) {
      return `{{ ${mapped}${parsed.filters} }}`;
    }

    // Inside `{% for i in event.Items %}` loops, `i.ProductID` etc. reference
    // loop variables, not schema instance fields. Redo doesn't expose
    // event.Items-style loops at all — the merchant must rebuild this.
    // Keep the token but flag as unmapped (caller's token count will spike
    // and the whole webhook gets skipped via the enrichment heuristic).
    unmappedTokens.push(parsed.varPath);
    return full;
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

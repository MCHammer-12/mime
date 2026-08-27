/**
 * Smoke test for rewriteKlaviyoLiquid's schema-scoped variables.
 *
 *   npx tsx src/flow/variable-mapping.smoke.ts
 *
 * Klaviyo's browse-abandonment SMS links back with `{{ event.URL }}`. Redo's
 * browse-abandonment trigger exposes the same thing as `browsedPageUrl`, but no
 * other trigger does — so the mapping has to be schema-scoped. Left unmapped it
 * 400s the whole createSmsTemplate call ("Message uses {{ event }}, which the
 * Browse abandonment trigger doesn't provide") and the SMS imports blank.
 */
import { rewriteKlaviyoLiquid } from "./variable-mapping.js";
import { SchemaType, type ParseWarning } from "./types.js";
import type { KlaviyoAccount } from "../fetch-account.js";

const ACCOUNT: KlaviyoAccount = {
  organizationName: "Bailey's Blossoms",
  websiteUrl: "http://www.baileysblossoms.com/",
  address: { street: "160 Private Road 4590", city: "Boyd", region: "TX", zip: "76023", country: "United States" },
};

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const body = `Head back: {{ event.URL|default:'' }}`;

// ─── Browse abandonment: event.URL → browsed_page_url ───────────────────
{
  const warnings: ParseWarning[] = [];
  const { output, unmappedTokens } = rewriteKlaviyoLiquid(
    body,
    warnings,
    "a1",
    SchemaType.MARKETING_BROWSE_ABANDONMENT,
  );
  assert(
    output === `Head back: {{ browsed_page_url|default:'' }}`,
    `event.URL mapped, got: ${JSON.stringify(output)}`,
  );
  assert(unmappedTokens.length === 0, `no unmapped tokens, got: ${unmappedTokens}`);
}

// ─── The CommentSold twin exposes the same field ────────────────────────
{
  const { output } = rewriteKlaviyoLiquid(
    body,
    [],
    "a1",
    SchemaType.MARKETING_COMMENTSOLD_BROWSE_ABANDONMENT,
  );
  assert(
    output.includes("browsed_page_url"),
    `CS browse abandonment maps too, got: ${JSON.stringify(output)}`,
  );
}

// ─── Cart abandonment exposes the same link as checkout_url ─────────────
{
  const { output, unmappedTokens } = rewriteKlaviyoLiquid(
    body,
    [],
    "a1",
    SchemaType.MARKETING_CART_ABANDONMENT,
  );
  assert(
    output === `Head back: {{ checkout_url|default:'' }}`,
    `cart abandonment event.URL → checkout_url, got: ${JSON.stringify(output)}`,
  );
  assert(unmappedTokens.length === 0, `no unmapped tokens, got: ${unmappedTokens}`);
}

// ─── Any other trigger has no such field. Klaviyo-namespaced tokens drop
//     to empty rather than passing through: Redo rejects the whole template
//     on an unknown token, which would cost the entire flow import. ───────
{
  const warnings: ParseWarning[] = [];
  const { output, unmappedTokens } = rewriteKlaviyoLiquid(
    body,
    warnings,
    "a1",
    SchemaType.ORDER_TRACKING,
  );
  assert(output === "Head back: ", `event.* dropped to empty, got: ${JSON.stringify(output)}`);
  assert(unmappedTokens.includes("event.URL"), `flagged unmapped, got: ${unmappedTokens}`);
  assert(warnings.length === 1, `warned once, got: ${warnings.length}`);
}

// ─── Tokens outside Klaviyo's namespaces pass through untouched ─────────
{
  const { output } = rewriteKlaviyoLiquid(
    `Hi {{ some_redo_var }}`,
    [],
    "a1",
    SchemaType.ORDER_TRACKING,
  );
  assert(
    output === `Hi {{ some_redo_var }}`,
    `non-Klaviyo token kept verbatim, got: ${JSON.stringify(output)}`,
  );
}

// ─── organization.* are merchant constants — resolved to literals ────────
{
  const warnings: ParseWarning[] = [];
  const { output, unmappedTokens } = rewriteKlaviyoLiquid(
    `Shop now: {{ organization.url }} — {{ organization.name }}, {{ organization.full_address }}`,
    warnings,
    "a1",
    SchemaType.ORDER_TRACKING,
    ACCOUNT,
  );
  assert(
    output ===
      "Shop now: http://www.baileysblossoms.com/ — Bailey's Blossoms, 160 Private Road 4590, Boyd, TX 76023, United States",
    `organization.* resolved inline, got: ${JSON.stringify(output)}`,
  );
  assert(unmappedTokens.length === 0, `no unmapped tokens, got: ${unmappedTokens}`);
  assert(warnings.length === 0, `no warnings, got: ${warnings.length}`);
}

// ─── No account → organization.* still can't reach Redo; drop + warn ─────
{
  const warnings: ParseWarning[] = [];
  const { output } = rewriteKlaviyoLiquid(
    `Shop now: {{ organization.url }}`,
    warnings,
    "a1",
    SchemaType.ORDER_TRACKING,
  );
  assert(output === "Shop now: ", `dropped without an account, got: ${JSON.stringify(output)}`);
  assert(warnings.length === 1, `warned once, got: ${warnings.length}`);
}

// ─── No schemaType passed behaves like the base map ─────────────────────
{
  const { unmappedTokens } = rewriteKlaviyoLiquid(body, [], "a1");
  assert(
    unmappedTokens.includes("event.URL"),
    `no schemaType → base map only, got: ${unmappedTokens}`,
  );
}

// ─── Base-map entries still resolve under a schema overlay ──────────────
{
  const { output } = rewriteKlaviyoLiquid(
    `Hi {{ person|lookup:"first_name"|default:'there' }}`,
    [],
    "a1",
    SchemaType.MARKETING_BROWSE_ABANDONMENT,
  );
  assert(
    output === `Hi {{ customer_first_name|default:'there' }}`,
    `base map intact under overlay, got: ${JSON.stringify(output)}`,
  );
}

console.log("variable-mapping.smoke.ts: all assertions passed");

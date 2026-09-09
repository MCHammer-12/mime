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
import { rewriteKlaviyoLiquid, sanitizeTemplateLiquid } from "./variable-mapping.js";
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

// ─── Bare profile shorthands ({{ first_name }}) ─────────────────────────
// Klaviyo's un-namespaced alias for person.first_name. Not a Klaviyo root, so
// the rewriter used to keep it verbatim and Redo 400'd the whole template.
{
  const warnings: ParseWarning[] = [];
  const { output, unmappedTokens } = rewriteKlaviyoLiquid(
    `Hey {{ first_name|default:'friend' }} {{ last_name }}`,
    warnings,
    "a1",
    SchemaType.SMS_MARKETING_SIGNUP,
  );
  assert(
    output === `Hey {{ customer_first_name|default:'friend' }} {{ customer_last_name }}`,
    `bare first_name/last_name mapped, got: ${JSON.stringify(output)}`,
  );
  assert(unmappedTokens.length === 0, `no unmapped tokens, got: ${unmappedTokens}`);
}

// ─── unsubscribe_link: base map, dropped on SMS sign-up ─────────────────
{
  const { output, unmappedTokens } = rewriteKlaviyoLiquid(
    `<a href="{{ unsubscribe_link }}">stop</a>`,
    [],
    "a1",
    SchemaType.EMAIL_MARKETING_SIGNUP,
  );
  assert(
    output === `<a href="{{ unsubscribe_link }}">stop</a>`,
    `unsubscribe_link kept where the trigger provides it, got: ${JSON.stringify(output)}`,
  );
  assert(
    unmappedTokens.length === 0,
    `unsubscribe_link no longer reported as dropped, got: ${unmappedTokens}`,
  );
}
{
  const { output, unmappedTokens } = rewriteKlaviyoLiquid(
    `<a href="{{ unsubscribe_link }}">stop</a>`,
    [],
    "a1",
    SchemaType.SMS_MARKETING_SIGNUP,
  );
  assert(
    output === `<a href="">stop</a>`,
    `unsubscribe_link dropped on SMS sign-up, got: ${JSON.stringify(output)}`,
  );
  assert(
    unmappedTokens.includes("unsubscribe_link"),
    `drop is reported, got: ${unmappedTokens}`,
  );
}

// ─── back-in-stock product card: price + variant deep-link ─────────────
// Klaviyo hand-rolls the card inside {% catalog %}: the price arrives as an
// output-style tag and the CTA appends the variant id to the product url.
// Before this mapping the tag was deleted (price vanished) and the id dropped
// (link ended in a dangling "?variant=") — Any Means Necessary, 2026-09-09.
{
  const node = {
    imageUrl: "{{ catalog_item.variant.featured_image.full.src }}",
    text: "{% currency_format catalog_item.variant.price|floatformat:2 %}",
    buttonLink: "{{ catalog_item.url }}?variant={{ catalog_item.variant.id }}",
  };
  const { unmappedTokens } = sanitizeTemplateLiquid(
    node,
    "a1",
    [],
    SchemaType.MARKETING_BACK_IN_STOCK,
  );
  assert(
    node.text === "{{ restocked_product.price }}",
    `currency_format unwrapped to the mapped price, got: ${JSON.stringify(node.text)}`,
  );
  assert(
    node.buttonLink ===
      "{{ back_in_stock_product_url }}?variant={{ product_variant_id }}",
    `variant deep-link intact, got: ${JSON.stringify(node.buttonLink)}`,
  );
  assert(
    node.imageUrl === "{{ restocked_product.image_url }}",
    `card image mapped, got: ${JSON.stringify(node.imageUrl)}`,
  );
  assert(
    unmappedTokens.length === 0,
    `whole card maps with nothing dropped, got: ${unmappedTokens}`,
  );
}

// The product-level image is the same field as the variant-level one; Klaviyo
// cards use whichever the merchant picked in the block editor.
{
  const node = { imageUrl: "{{ catalog_item.featured_image.full.src }}" };
  sanitizeTemplateLiquid(node, "a1", [], SchemaType.MARKETING_BACK_IN_STOCK);
  assert(
    node.imageUrl === "{{ restocked_product.image_url }}",
    `product-level image mapped, got: ${JSON.stringify(node.imageUrl)}`,
  );
}

// A currency_format whose argument doesn't map still ends up empty rather than
// leaking the tag as literal text — the pre-existing guarantee.
{
  const node = { text: "{% currency_format catalog_item.nope %}" };
  const { unmappedTokens } = sanitizeTemplateLiquid(
    node,
    "a1",
    [],
    SchemaType.MARKETING_BACK_IN_STOCK,
  );
  assert(node.text === "", `unmappable currency_format empties, got: ${JSON.stringify(node.text)}`);
  assert(
    unmappedTokens.includes("catalog_item.nope"),
    `unmappable argument reported, got: ${unmappedTokens}`,
  );
}

console.log("variable-mapping.smoke.ts: all assertions passed");

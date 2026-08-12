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

// ─── Any other trigger has no such field — leave it unmapped + warned ───
{
  const warnings: ParseWarning[] = [];
  const { output, unmappedTokens } = rewriteKlaviyoLiquid(
    body,
    warnings,
    "a1",
    SchemaType.ORDER_TRACKING,
  );
  assert(output === body, `non-browse schema unchanged, got: ${JSON.stringify(output)}`);
  assert(unmappedTokens.includes("event.URL"), `flagged unmapped, got: ${unmappedTokens}`);
  assert(warnings.length === 1, `warned once, got: ${warnings.length}`);
}

// ─── No schemaType passed behaves like the base map ─────────────────────
{
  const { output } = rewriteKlaviyoLiquid(body, [], "a1");
  assert(output === body, `no schemaType → base map only, got: ${JSON.stringify(output)}`);
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

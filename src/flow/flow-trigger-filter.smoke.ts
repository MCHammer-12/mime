/**
 * Smoke test for translateFlowTriggerFilter — Klaviyo's flow-level
 * `trigger_filter` → Redo trigger gating. Cases come from Glow Group's
 * six filtered flows.
 *
 *   npx tsx src/flow/flow-trigger-filter.smoke.ts
 */
import { translateFlowTriggerFilter } from "./condition-mapping.js";
import { SchemaType, type ParseWarning } from "./types.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

function filter(field: string, type: string, operator: string, value: string) {
  return {
    condition_groups: [
      {
        conditions: [
          {
            type: "metric-property",
            metric_id: "M1",
            field,
            filter: { type, operator, value },
          },
        ],
      },
    ],
  };
}

// ─── Positive string on order_tracking → gate, array-wrapped ─────────────
{
  const warnings: ParseWarning[] = [];
  const out = translateFlowTriggerFilter(
    filter("Name", "string", "equals", "Full Email & Text Automation Program"),
    SchemaType.ORDER_TRACKING,
    warnings,
  );
  assert(out?.kind === "gate", "positive filter gates");
  const e = (out as any).expression;
  assert(e.dataSource === "trigger-data", "gate is trigger-data");
  assert(
    e.schemaBooleanExpression.type === "array_predicate" &&
      e.schemaBooleanExpression.field === "productNames" &&
      e.schemaBooleanExpression.operator === "some",
    "Multiple Text field wraps in array_predicate/some",
  );
  const inner = e.schemaBooleanExpression.condition;
  assert(
    inner.type === "text_match" &&
      inner.field === "productNames" &&
      inner.operator === "equals" &&
      inner.matchValues[0] === "Full Email & Text Automation Program",
    "inner text_match reuses the outer field name",
  );
}

// ─── Positive list on order_tracking → gate with `includes` ──────────────
{
  const warnings: ParseWarning[] = [];
  const out = translateFlowTriggerFilter(
    filter("Items", "list", "contains", "Full Text Automation Program"),
    SchemaType.ORDER_TRACKING,
    warnings,
  );
  assert(out?.kind === "gate", "list contains gates");
  const inner = (out as any).expression.schemaBooleanExpression.condition;
  assert(inner.operator === "includes", "list contains → text_match includes");
}

// ─── Negative string on checkout abandonment → inverted skip ─────────────
{
  const warnings: ParseWarning[] = [];
  const out = translateFlowTriggerFilter(
    filter("Source Name", "string", "not-equals", "pos"),
    SchemaType.MARKETING_CHECKOUT_ABANDONMENT,
    warnings,
  );
  assert(out?.kind === "skip", "negative filter becomes a skip condition");
  const e = (out as any).expression.schemaBooleanExpression;
  assert(
    e.type === "text_match" &&
      e.field === "sourceName" &&
      e.operator === "equals" &&
      e.matchValues[0] === "pos",
    "not-equals inverts to a positive equals skip",
  );
}

// ─── Negative list on browse abandonment → inverted skip ─────────────────
{
  const warnings: ParseWarning[] = [];
  const out = translateFlowTriggerFilter(
    filter("URL", "string", "not-contains", "commentsold.com"),
    SchemaType.MARKETING_BROWSE_ABANDONMENT,
    warnings,
  );
  assert(out?.kind === "skip", "not-contains becomes a skip condition");
  const e = (out as any).expression.schemaBooleanExpression;
  assert(
    e.field === "browsedPageUrl" && e.operator === "includes",
    "URL → browsedPageUrl, not-contains inverts to includes",
  );
}

// ─── Field with no Redo equivalent → null, caller warns ──────────────────
{
  const warnings: ParseWarning[] = [];
  const out = translateFlowTriggerFilter(
    filter("Collections", "list", "contains", "Automations"),
    SchemaType.ORDER_TRACKING,
    warnings,
  );
  assert(out === null, "order_tracking has no collections field → null");
}

// ─── Right field name, wrong schema → null ───────────────────────────────
{
  const warnings: ParseWarning[] = [];
  const out = translateFlowTriggerFilter(
    filter("URL", "string", "not-contains", "commentsold.com"),
    SchemaType.ORDER_TRACKING,
    warnings,
  );
  assert(out === null, "URL only resolves on browse-abandonment schemas");
}

// ─── Extra AND'd condition is dropped, and says so ───────────────────────
{
  const warnings: ParseWarning[] = [];
  const tf = filter("Name", "string", "equals", "A");
  tf.condition_groups[0].conditions.push({
    type: "metric-property",
    metric_id: "M1",
    field: "Collections",
    filter: { type: "list", operator: "contains", value: "B" },
  });
  const out = translateFlowTriggerFilter(tf, SchemaType.ORDER_TRACKING, warnings);
  assert(out?.kind === "gate", "still translates the field it understands");
  assert(
    warnings.some((w) => w.message.includes("AND's 2 conditions")),
    "warns that the second AND'd condition was dropped",
  );
}

console.log("flow-trigger-filter.smoke.ts: all assertions passed");

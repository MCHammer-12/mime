import type { MetricLookup } from "../extract-metrics.js";
import { SchemaType, type KlaviyoAction, type ParseWarning } from "./types.js";

// Klaviyo metric name (lowercased) → Redo CustomerActivityType enum value.
// Source: redo/model/src/marketing/segments/segment-types.ts:108
const METRIC_TO_ACTIVITY: Record<string, string> = {
  "opened email":      "opened-email",
  "clicked email":     "clicked-email",
  "received email":    "received-email",
  "clicked text":      "clicked-text",
  "received text":     "received-text",
  "viewed product":    "viewed-product",
  "added to cart":     "added-product-to-cart",
  "placed order":      "order-placed",
  "started checkout":  "checkout-started",
  "checkout started":  "checkout-started",
  "active on site":    "active-on-site",
  "viewed collection": "collection-viewed",
};

const TIMEFRAME_UNITS: Record<string, string> = {
  hour: "hour", hours: "hour",
  day: "day", days: "day",
  week: "week", weeks: "week",
  month: "month", months: "month",
};

// Translate Klaviyo's {operator, value} into Redo's ActivityCount shape.
// Enum values from segment-types.ts:198 (ActivityCountType).
function translateCount(
  operator: string,
  value: number,
): { type: string; n?: number } {
  const n = Math.max(0, Math.floor(value));
  switch (operator) {
    case "equals":
      return n === 0 ? { type: "zero_times" } : { type: "n_times", n };
    case "not-equals":
      return { type: "not_n_times", n };
    case "greater-than":
      // Klaviyo's ">0" renders as "at least once" in the UI — match that.
      return n === 0 ? { type: "at_least_once" } : { type: "greater_than_n", n };
    case "greater-than-or-equal":
      // ">=1" also renders as "at least once"; otherwise "at least N".
      return n === 1 ? { type: "at_least_once" } : { type: "at_least_n", n };
    case "less-than":
      return { type: "less_than_n", n };
    case "less-than-or-equal":
      return { type: "at_most_n", n };
    default:
      return { type: "at_least_once" };
  }
}

function translateTimeframe(
  tf: any,
  warnings: ParseWarning[],
  actionId: string,
): unknown {
  if (!tf) return { type: "all-time" };
  const op = tf.operator ?? tf.type;
  switch (op) {
    case "flow-start":
    case "flow_start":
      // automationStartTime is filled at runtime by Redo; we emit a current
      // placeholder (mirrors how the Redo UI does it at condition-create time).
      return {
        type: "automation-start",
        automationStartTime: new Date().toISOString(),
      };
    case "alltime":
    case "all-time":
      return { type: "all-time" };
    case "in-the-last":
      return {
        type: "before-now-relative",
        value: Number(tf.value ?? 1),
        units: TIMEFRAME_UNITS[tf.unit ?? "day"] ?? "day",
      };
    default:
      warnings.push({
        kind: "requires-review",
        actionId,
        message: `unknown timeframe operator "${op}" — defaulted to all-time`,
      });
      return { type: "all-time" };
  }
}

function translateProfileMetricCondition(
  c: any,
  metrics: MetricLookup,
  warnings: ParseWarning[],
  actionId: string,
): unknown | null {
  const metric = metrics[c.metric_id];
  if (!metric) {
    warnings.push({
      kind: "requires-review",
      actionId,
      message: `condition references unknown metric ${c.metric_id} — manual config required`,
    });
    return null;
  }
  const activityType = METRIC_TO_ACTIVITY[metric.name.toLowerCase()];
  if (!activityType) {
    warnings.push({
      kind: "requires-review",
      actionId,
      message: `condition metric "${metric.name}" has no Redo activity equivalent — manual config required`,
    });
    return null;
  }
  const operator = c.measurement_filter?.operator ?? "greater-than";
  const value = Number(c.measurement_filter?.value ?? 0);
  return {
    type: "customer_activity",
    activityType,
    count: translateCount(operator, value),
    timeframe: translateTimeframe(c.timeframe_filter, warnings, actionId),
    whereConditions: [],
  };
}

// ---------- Klaviyo trigger-split (metric-property) → Redo TriggerData ----------

// Klaviyo trigger-split evaluates event fields via metric-property conditions
// (e.g. `Name equals "SomeProduct"`). Redo expresses this as a TriggerData
// schemaBooleanExpression: text_match / number_comparison against a field on
// the trigger schema instance.
//
// Klaviyo field names on the event differ from Redo schema instance fields;
// map per trigger schemaType for the common cases.
function resolveTriggerField(
  klaviyoField: string,
  schemaType: SchemaType,
): string | null {
  const f = klaviyoField.toLowerCase();
  // "Name" = product name on Added to Cart / Viewed Product events.
  if (f === "name") {
    if (
      schemaType === SchemaType.MARKETING_CART_ABANDONMENT ||
      schemaType === SchemaType.MARKETING_COMMENTSOLD_CART_ABANDONMENT
    ) {
      return "productInCartName";
    }
    // checkout / browse don't expose a simple product-name field in their schema.
    return null;
  }
  // "$value" = order/checkout total
  if (f === "$value" || f === "value") {
    if (schemaType === SchemaType.MARKETING_CHECKOUT_ABANDONMENT) {
      return "cartSubtotal";
    }
    return null;
  }
  return null;
}

const STRING_OP_TO_TEXT_MATCH: Record<string, string> = {
  "equals":       "equals",
  "starts-with":  "startsWith",
  "ends-with":    "endsWith",
  "contains":     "includes",
};

const NUMBER_OP_TO_COMPARISON: Record<string, string> = {
  "equals":                "equals",
  "not-equals":            "notEquals",
  "greater-than":          "greaterThan",
  "greater-than-or-equal": "greaterThanOrEqual",
  "less-than":             "lessThan",
  "less-than-or-equal":    "lessThanOrEqual",
};

export function translateTriggerSplitExpression(
  action: KlaviyoAction,
  schemaType: SchemaType,
  warnings: ParseWarning[],
): unknown {
  const tf = action.data?.trigger_filter;
  const groups = tf?.condition_groups ?? [];
  if (groups.length === 0) {
    return null;
  }
  if (groups.length > 1) {
    warnings.push({
      kind: "requires-review",
      actionId: action.id,
      message: `trigger-split has ${groups.length} OR'd groups — V1 uses first group only`,
    });
  }
  const conditions = groups[0].conditions ?? [];
  if (conditions.length === 0) return null;

  // Klaviyo allows multiple metric-property conditions OR'd on the same
  // field (e.g. 8 "Name equals X" for product routing). Group by field
  // + operator; collect matchValues for text_match expressions.
  const first = conditions[0];
  if (first.type !== "metric-property") {
    warnings.push({
      kind: "requires-review",
      actionId: action.id,
      message: `trigger-split condition type "${first.type}" not supported — manual config required`,
    });
    return null;
  }

  const redoField = resolveTriggerField(first.field, schemaType);
  if (!redoField) {
    warnings.push({
      kind: "requires-review",
      actionId: action.id,
      message: `trigger-split on Klaviyo field "${first.field}" has no Redo schema field for ${schemaType} — manual config required`,
    });
    return null;
  }

  const filterType = first.filter?.type;
  const opKey = first.filter?.operator;

  if (filterType === "string") {
    const op = STRING_OP_TO_TEXT_MATCH[opKey];
    if (!op) {
      warnings.push({
        kind: "requires-review",
        actionId: action.id,
        message: `trigger-split string operator "${opKey}" not translatable`,
      });
      return null;
    }
    // Collect values across all conditions that share field + operator
    const matchValues: string[] = [];
    for (const c of conditions) {
      if (
        c.type === "metric-property" &&
        c.field === first.field &&
        c.filter?.operator === opKey
      ) {
        matchValues.push(String(c.filter.value));
      }
    }
    return {
      dataSource: "trigger-data",
      schemaBooleanExpression: {
        type: "text_match",
        field: redoField,
        operator: op,
        matchValues,
      },
    };
  }

  if (filterType === "numeric") {
    const op = NUMBER_OP_TO_COMPARISON[opKey];
    if (!op) {
      warnings.push({
        kind: "requires-review",
        actionId: action.id,
        message: `trigger-split numeric operator "${opKey}" not translatable`,
      });
      return null;
    }
    return {
      dataSource: "trigger-data",
      schemaBooleanExpression: {
        type: "number_comparison",
        field: redoField,
        operator: op,
        comparisonValue: Number(first.filter.value),
      },
    };
  }

  warnings.push({
    kind: "requires-review",
    actionId: action.id,
    message: `trigger-split filter type "${filterType}" not supported`,
  });
  return null;
}

// ---------- Klaviyo profile-property → Redo CustomerAttributeCondition ----------
// V1 limitation: emits a warning + empty condition. Redo's CustomerAttribute
// conditions use a WhereCondition structure keyed on a "dimension" (e.g.
// custom-fields, customer-tags). Klaviyo custom property names don't map 1:1;
// needs team-level customer-group setup before this can be auto-translated.
function profilePropertyPlaceholder(
  c: any,
  warnings: ParseWarning[],
  actionId: string,
): null {
  const op = c.filter?.operator ?? "equals";
  const val = c.filter?.value ?? "";
  warnings.push({
    kind: "requires-review",
    actionId,
    message: `profile-property condition (${c.property} ${op} "${val}") — manual config required; Redo custom-property conditions need team-level segment setup`,
  });
  return null;
}

// ---------- Klaviyo profile-group-membership → Redo ExistingSegment ----------
// V1 limitation: Klaviyo list IDs don't map to Redo segment IDs; merchant
// needs to recreate the segment in Redo first, then wire it up manually.
function profileGroupMembershipPlaceholder(
  c: any,
  warnings: ParseWarning[],
  actionId: string,
): null {
  const groupIds = c.group_ids ?? [];
  warnings.push({
    kind: "requires-review",
    actionId,
    message: `profile-group-membership condition (is_member=${c.is_member}, klaviyo_list_ids=[${groupIds.join(",")}]) — manual config required; recreate segment in Redo first`,
  });
  return null;
}

// Translate a Klaviyo conditional-split into a Redo InlineSegment expression.
// Redo's CONDITION step uses the SegmentConditionBlock interface shape
// (segment-types.ts:177) — NOT the queryConditionSchema Zod shape. Field names:
//   - activityType (not "event")
//   - count: { type: ActivityCountType, n? }   (not { operator, value })
//   - whereConditions (not "event_filters")
//   - timeframe is flat (e.g. { type, automationStartTime } — no options wrapper)
// The DB schema accepts z.array(z.any()) so both shapes pass validation, but the
// UI reads via SegmentConditionBlockType and will error on the Zod shape.
export function translateConditionalSplitExpression(
  action: KlaviyoAction,
  metrics: MetricLookup,
  warnings: ParseWarning[],
): unknown {
  const pf = action.data?.profile_filter;
  const groups = pf?.condition_groups ?? [];
  if (groups.length === 0) {
    return {
      dataSource: "inline-segment",
      inlineSegment: { mode: "AND", conditions: [] },
    };
  }
  if (groups.length > 1) {
    warnings.push({
      kind: "requires-review",
      actionId: action.id,
      message: `conditional-split has ${groups.length} OR'd groups — V1 flattens to first group; review in Redo UI`,
    });
  }
  const klaviyoConditions = groups[0].conditions ?? [];
  const redoConditions: unknown[] = [];
  for (const kc of klaviyoConditions) {
    switch (kc.type) {
      case "profile-metric": {
        const rc = translateProfileMetricCondition(kc, metrics, warnings, action.id);
        if (rc) redoConditions.push(rc);
        break;
      }
      case "profile-property":
        profilePropertyPlaceholder(kc, warnings, action.id);
        break;
      case "profile-group-membership":
        profileGroupMembershipPlaceholder(kc, warnings, action.id);
        break;
      default:
        warnings.push({
          kind: "requires-review",
          actionId: action.id,
          message: `condition type "${kc.type}" not yet translated — manual config required`,
        });
    }
  }
  return {
    dataSource: "inline-segment",
    inlineSegment: { mode: "AND", conditions: redoConditions },
  };
}

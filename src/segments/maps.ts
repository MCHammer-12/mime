// Klaviyo → Redo lookup tables + pure helpers for the segment translator.
//
// The metric/operator/unit tables mirror the canonical ones in
// src/flow/condition-mapping.ts. They're duplicated (not imported) on purpose:
// that file is on the flow-import hot path and produces the SegmentConditionBlock
// *interface* shape, whereas segments need the ZOD shape. Keeping a local copy
// avoids widening the flow module's API or risking behavioral drift there. If
// these ever disagree, condition-mapping.ts is the source of truth for the
// metric/operator maps; the timeframe emitter below is segment-specific (zod
// `{type, options}` shape, not the flat interface shape).

import type {
  EventCount,
  NumericOperator,
  StringOperator,
  Timeframe,
  TimeframeUnit,
  WhereCondition,
} from "./redo-types.js";

export const KLAVIYO_NUMERIC_OP_TO_REDO: Record<string, NumericOperator> = {
  equals: "eq",
  "not-equals": "neq",
  "greater-than": "gt",
  "greater-than-or-equal": "gte",
  "less-than": "lt",
  "less-than-or-equal": "lte",
};

export const KLAVIYO_STRING_OP_TO_REDO: Record<string, StringOperator> = {
  contains: "contains",
  "does-not-contain": "not_contains",
  "not-contains": "not_contains",
  "starts-with": "starts_with",
  "ends-with": "ends_with",
};

export const TIMEFRAME_UNITS: Record<string, TimeframeUnit> = {
  hour: "hour",
  hours: "hour",
  day: "day",
  days: "day",
  week: "week",
  weeks: "week",
  month: "month",
  months: "month",
};

// Klaviyo metric name (lowercased) → Redo CustomerActivityType (Shopify values).
// Mirror of METRIC_TO_ACTIVITY in src/flow/condition-mapping.ts.
export const METRIC_TO_ACTIVITY: Record<string, string> = {
  "opened email": "opened-email",
  "clicked email": "clicked-email",
  "received email": "received-email",
  "clicked text": "clicked-text",
  "received text": "received-text",
  "viewed product": "viewed-product",
  "added to cart": "added-product-to-cart",
  "placed order": "order-placed",
  "ordered product": "order-placed",
  "started checkout": "checkout-started",
  "checkout started": "checkout-started",
  "active on site": "active-on-site",
  "viewed collection": "collection-viewed",
  // Resolved 2026-06-16: refund ≈ Redo return; back-in-stock has a direct activity.
  "refunded order": "return-processed",
  "subscribed to back in stock": "subscribed-to-back-in-stock",
  // Current main (2026-06-17) added a bounced-email activity.
  "bounced email": "bounced-email",
};

// Klaviyo metrics we deliberately drop (Michael 2026-06-16: cancelled has no
// Redo equivalent). Everything else unmapped falls back to a count-gated
// custom_event (see translate.ts) per the "map more, verify by count" approach.
export const METRIC_EXPLICIT_DROP: Record<string, string> = {
  "cancelled order": "no cancellation activity in Redo (per 2026-06-16 decision)",
  "canceled order": "no cancellation activity in Redo (per 2026-06-16 decision)",
};

/** Klaviyo `metric_filters` entry → a Redo custom_event property filter (free
 *  dimension = the event property key; numeric vs token by filter type). */
export function customEventPropertyFilter(
  property: string,
  filter: { type?: string; operator?: string; value?: unknown } | undefined,
): WhereCondition | null {
  if (!property || !filter) return null;
  const isNumeric = filter.type === "numeric" || typeof filter.value === "number";
  if (isNumeric) {
    const redoOp = filter.operator ? KLAVIYO_NUMERIC_OP_TO_REDO[filter.operator] : undefined;
    if (!redoOp) return null;
    return { type: "numeric", dimension: property, comparison: { type: "numeric", operator: redoOp, value: Number(filter.value ?? 0) } };
  }
  const negate = filter.operator === "not-equals" || filter.operator === "does-not-contain";
  const values = (Array.isArray(filter.value) ? filter.value : [filter.value]).map((v) => String(v ?? "")).filter(Boolean);
  if (values.length === 0) return null;
  return { type: "token", dimension: property, comparison: { type: "token", operator: negate ? "NONE" : "ANY", values } };
}

// Klaviyo `measurement` selectors meaning "sum of the $value property" rather
// than an event count.
export const VALUE_MEASUREMENTS = new Set(["sum_value", "value", "sum"]);

// Redo activity → the NUMERIC event_filter dimension carrying the event's
// monetary value. Mirror of ACTIVITY_VALUE_DIMENSION in condition-mapping.ts.
export const ACTIVITY_VALUE_DIMENSION: Record<string, string> = {
  "added-product-to-cart": "cart_subtotal",
  "order-placed": "order_total",
};

/** Klaviyo numeric {operator, value} → Redo segment EventCount {operator, value}.
 *  Falls back to "at least once" (gt 0) for unknown operators. */
export function countFrom(operator: string | undefined, value: number): EventCount {
  const op = operator ? KLAVIYO_NUMERIC_OP_TO_REDO[operator] : undefined;
  if (!op) return { operator: "gt", value: 0 };
  return { operator: op, value };
}

/** Coerce a Klaviyo date/datetime string to the YYYY-MM-DD that Redo's zod
 *  `z.string().date()` requires. */
function toDateString(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  // Already YYYY-MM-DD, or an ISO datetime — take the date portion.
  const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** Klaviyo timeframe_filter → Redo Timeframe (zod `{type, options}` shape).
 *  Absent/unrecognized → all-time. */
export function timeframeFrom(tf: any): Timeframe {
  if (!tf) return { type: "all-time", options: null };
  const op = String(tf.operator ?? tf.type ?? "").toLowerCase();
  switch (op) {
    case "in-the-last": {
      const value = Number(tf.quantity ?? tf.value ?? 1);
      const units = TIMEFRAME_UNITS[String(tf.unit ?? "day")] ?? "day";
      return { type: "before-now-relative", options: { value, units } };
    }
    case "after": {
      const date = toDateString(tf.value);
      return date
        ? { type: "after", options: { date } }
        : { type: "all-time", options: null };
    }
    case "before": {
      const date = toDateString(tf.value);
      return date
        ? { type: "before", options: { date } }
        : { type: "all-time", options: null };
    }
    case "on": {
      const date = toDateString(tf.value);
      return date
        ? { type: "on", options: { date } }
        : { type: "all-time", options: null };
    }
    case "between":
    case "between-static":
    case "between-dates": {
      // Absolute date range: value is [from, to]. Relative range (e.g. 30–90
      // days ago) carries start/end + unit instead.
      if (tf.start != null && tf.end != null) {
        const units = TIMEFRAME_UNITS[String(tf.unit ?? "day")] ?? "day";
        return { type: "between-relative", options: { start: Number(tf.start), end: Number(tf.end), units } };
      }
      const arr = Array.isArray(tf.value) ? tf.value : [];
      const from = toDateString(arr[0]);
      const to = toDateString(arr[1]);
      return from && to
        ? { type: "between-dates", options: { range: [from, to] } }
        : { type: "all-time", options: null };
    }
    case "alltime":
    case "all-time":
    case "":
      return { type: "all-time", options: null };
    default:
      return { type: "all-time", options: null };
  }
}

// Klaviyo event-property → Redo event_filter field, per activity. The token vs
// token_list distinction matters (order-placed product_name is a token_list;
// viewed/cart product_name is a single token) — wrong type = a Zod 400. Mirrors
// redoapp segment-data-structures.ts. Klaviyo prop keys are normalized
// (lowercased, `$` and spaces stripped) before lookup.
type EventFieldType = "numeric" | "token" | "token_list";
interface EventFieldSpec {
  field: string;
  type: EventFieldType;
}

const EVENT_FIELDS: Record<string, Record<string, EventFieldSpec>> = {
  "order-placed": {
    value: { field: "order_total", type: "numeric" },
    itemcount: { field: "item_count", type: "numeric" },
    items: { field: "product_name", type: "token_list" },
    name: { field: "product_name", type: "token_list" },
    productname: { field: "product_name", type: "token_list" },
    productid: { field: "product_id", type: "token_list" },
    collections: { field: "collection_name", type: "token_list" },
    collection: { field: "collection_name", type: "token_list" },
    categories: { field: "collection_name", type: "token_list" },
    vendor: { field: "vendor", type: "token_list" },
    brand: { field: "vendor", type: "token_list" },
    sku: { field: "product_variant_sku", type: "token_list" },
    variantname: { field: "product_variant_name", type: "token_list" },
    variantid: { field: "product_variant_id", type: "token_list" },
  },
  "added-product-to-cart": {
    value: { field: "cart_subtotal", type: "numeric" },
    quantity: { field: "quantity", type: "numeric" },
    name: { field: "product_name", type: "token" },
    productname: { field: "product_name", type: "token" },
    productid: { field: "product_id", type: "token" },
    collections: { field: "product_collection", type: "token_list" },
    collection: { field: "product_collection", type: "token_list" },
    categories: { field: "product_collection", type: "token_list" },
    sku: { field: "product_variant_sku", type: "token" },
    variantname: { field: "product_variant_name", type: "token" },
    variantid: { field: "product_variant_id", type: "token" },
  },
  "viewed-product": {
    name: { field: "product_name", type: "token" },
    productname: { field: "product_name", type: "token" },
    product: { field: "product_name", type: "token" },
    productid: { field: "product_id", type: "token" },
    categories: { field: "collection_name", type: "token_list" },
    collections: { field: "collection_name", type: "token_list" },
    collection: { field: "collection_name", type: "token_list" },
    sku: { field: "product_variant_sku", type: "token" },
    tags: { field: "product_tags", type: "token_list" },
  },
  "collection-viewed": {
    collectionname: { field: "collection_name", type: "token" },
    collection: { field: "collection_name", type: "token" },
    name: { field: "collection_name", type: "token" },
    collectionid: { field: "collection_id", type: "token" },
  },
};

function normalizeProp(prop: string): string {
  return prop.toLowerCase().replace(/[$\s_]/g, "");
}

/** Klaviyo `metric_filters[]` entry → a Redo event_filter WhereCondition, or
 *  null when the property/operator has no Redo field (caller warns + skips). */
export function mapMetricFilter(
  activity: string,
  property: string,
  filter: { type?: string; operator?: string; value?: unknown } | undefined,
): WhereCondition | null {
  const spec = EVENT_FIELDS[activity]?.[normalizeProp(property)];
  if (!spec || !filter) return null;
  const op = filter.operator;

  if (spec.type === "numeric") {
    const redoOp = op ? KLAVIYO_NUMERIC_OP_TO_REDO[op] : undefined;
    if (!redoOp) return null;
    return {
      type: "numeric",
      dimension: spec.field,
      comparison: { type: "numeric", operator: redoOp, value: Number(filter.value ?? 0) },
    };
  }

  // token / token_list: Klaviyo equals/contains → membership; negations → none.
  const negate = op === "not-equals" || op === "does-not-contain" || op === "not-contains";
  const values = (Array.isArray(filter.value) ? filter.value : [filter.value])
    .map((v) => String(v ?? ""))
    .filter(Boolean);
  if (values.length === 0) return null;

  if (spec.type === "token") {
    return {
      type: "token",
      dimension: spec.field,
      comparison: { type: "token", operator: negate ? "NONE" : "ANY", values },
    };
  }
  return {
    type: "token_list",
    dimension: spec.field,
    comparison: { type: "list", operator: negate ? "none" : "any", values },
  };
}

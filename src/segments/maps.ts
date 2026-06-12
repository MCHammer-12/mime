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
};

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
    case "alltime":
    case "all-time":
    case "":
      return { type: "all-time", options: null };
    default:
      return { type: "all-time", options: null };
  }
}

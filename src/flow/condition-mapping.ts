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
  // Klaviyo's "Ordered Product" fires once per line item; Redo has no
  // per-line-item activity, so collapse into the per-order activity.
  // Conditions like "Ordered Product zero times" still resolve correctly
  // (zero line items ⇔ zero orders).
  "ordered product":   "order-placed",
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

// Klaviyo numeric operator → Redo NumericCompareOperator (segment-where-
// condition.ts: eq/gt/lt/gte/lte/neq). Used for the value-measurement
// whereCondition (e.g. "cart subtotal greater-than 74.99 → gt").
const KLAVIYO_NUMERIC_OP_TO_REDO: Record<string, string> = {
  "equals": "eq",
  "not-equals": "neq",
  "greater-than": "gt",
  "greater-than-or-equal": "gte",
  "less-than": "lt",
  "less-than-or-equal": "lte",
};

// Redo activity → the NUMERIC whereCondition dimension that carries the
// event's monetary value, for translating Klaviyo "Value" (sum_value)
// measurements. Confirmed against redoapp segment-data-structures.ts:
//   - added-product-to-cart → "cart_subtotal" (ProductAddedToCartSegmentFields)
//   - order-placed          → "order_total"   (OrderPlacedSegmentFields)
// checkout-started / active-on-site / viewed-product expose no monetary
// field, so a value split on those can't be mapped — caller warns.
const ACTIVITY_VALUE_DIMENSION: Record<string, string> = {
  "added-product-to-cart": "cart_subtotal",
  "order-placed": "order_total",
};

// Klaviyo `measurement` selectors that mean "sum of the $value property"
// rather than a count of events. Anything here routes through the value
// path (count: at_least_once + a numeric whereCondition); `count` (or
// absent) keeps the existing count-threshold behavior.
const VALUE_MEASUREMENTS = new Set(["sum_value", "value", "sum"]);

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
      // Klaviyo's `in-the-last` timeframe shape uses `quantity` (verified
      // across every flow in the corpus). `tf.value` was a misread of the
      // shape and always resolved to undefined → 1 day. SHOC bundle
      // 2026-05-21 surfaced this — merchant set "in last 30 days" but
      // Redo received "in last 1 day". Keep the `value` fallback for any
      // future Klaviyo API revision that introduces it.
      return {
        type: "before-now-relative",
        value: Number(tf.quantity ?? tf.value ?? 1),
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
  const measurement = String(c.measurement ?? "count").toLowerCase();
  const timeframe = translateTimeframe(c.timeframe_filter, warnings, actionId);

  // Value-measurement path: Klaviyo "Added to Cart VALUE > 74.99" is a
  // dollar threshold on the event's value property — NOT an event count.
  // Routing it through translateCount would emit "added to cart > 74
  // TIMES" (Math.floor(74.99)). Instead emit count: at_least_once + a
  // numeric whereCondition on the activity's monetary dimension.
  if (VALUE_MEASUREMENTS.has(measurement)) {
    const dimension = ACTIVITY_VALUE_DIMENSION[activityType];
    const redoOp = KLAVIYO_NUMERIC_OP_TO_REDO[operator];
    if (!dimension || !redoOp) {
      warnings.push({
        kind: "requires-review",
        actionId,
        message: `condition on "${metric.name}" value (${operator} ${value}) — no Redo value dimension for activity "${activityType}"; manual config required`,
      });
      return null;
    }
    // Semantic note: Klaviyo's "Value" measurement is a SUM of the value
    // property across the window; Redo's whereCondition is per-event
    // (∃ an event whose value crosses the threshold). They coincide for
    // the common single-event intent ("a cart/order worth > $X") and this
    // matches the hand-built Redo equivalent — flagged for verification.
    warnings.push({
      kind: "degraded-mapping",
      actionId,
      message: `"${metric.name}" value measurement (${operator} ${value}) mapped to Redo activity where ${dimension} ${redoOp} ${value}. Klaviyo sums the value over the window; Redo matches per-event — verify the split in the Redo flow builder.`,
    });
    return {
      type: "customer_activity",
      activityType,
      count: { type: "at_least_once" },
      timeframe,
      whereConditions: [
        {
          type: "numeric",
          dimension,
          comparison: { type: "numeric", operator: redoOp, value },
        },
      ],
    };
  }

  // Unrecognized non-count measurement (e.g. "unique") — don't silently
  // route a non-count value through the count path. Warn + skip.
  if (measurement !== "count") {
    warnings.push({
      kind: "requires-review",
      actionId,
      message: `condition on "${metric.name}" uses measurement "${measurement}" which mime doesn't translate yet — manual config required`,
    });
    return null;
  }

  return {
    type: "customer_activity",
    activityType,
    count: translateCount(operator, value),
    timeframe,
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

// ---------- Klaviyo profile-property: phone-country-code → Redo country ----------
//
// Klaviyo's `phone-country-code-in` / `-not-in` operator on the
// `phone_number` profile property filters by the phone number's country.
// Redo has a native `country` customer-attribute dimension (confirmed in
// redoapp `segment-types.ts` CustomerCharacteristicType.COUNTRY = "country",
// SQL path `location_country_code`, token comparison with ISO-code values).
// Shape (from redoapp's own segment test):
//   { type: "customer_attribute",
//     whereCondition: { type: "token", dimension: "country",
//       comparison: { type: "token", operator: "ANY"|"NONE", values: ["US","CA"] } } }
//
// SEMANTIC NOTE: Klaviyo keys on the PHONE NUMBER's country code; Redo's
// `country` dimension is the customer's PROFILE/location country. They
// align for nearly all SMS audiences, and it's exactly what merchants
// build by hand in Redo (Yes Homo's operator did this manually). It's a
// profile-country approximation of a phone-country filter — flagged via
// warning so the operator can verify. Redo has no phone-country-code
// dimension (only `phone-number-area-code`, which is US area codes).
const PHONE_COUNTRY_CODE_OPERATORS: Record<string, "ANY" | "NONE"> = {
  "phone-country-code-in": "ANY",
  "phone-country-code-not-in": "NONE",
};

function normalizeCountryCodes(raw: unknown): string[] {
  // Klaviyo emits the value as an array (["US","CA"]) or a comma-joined
  // string ("US,CA"). Normalize to uppercased ISO-2 codes.
  const parts = Array.isArray(raw)
    ? raw
    : String(raw ?? "").split(",");
  return parts
    .map((p) => String(p).trim().toUpperCase())
    .filter((p) => /^[A-Z]{2}$/.test(p));
}

function translatePhoneCountryCodeCondition(
  c: any,
  warnings: ParseWarning[],
  actionId: string,
): unknown | null {
  const op = c.filter?.operator;
  const redoOperator = op ? PHONE_COUNTRY_CODE_OPERATORS[op] : undefined;
  if (!redoOperator) return null;

  const values = normalizeCountryCodes(c.filter?.value);
  if (values.length === 0) return null;

  warnings.push({
    kind: "degraded-mapping",
    actionId,
    message: `phone-country-code condition (${op} ${values.join(",")}) mapped to Redo's profile "country" dimension. Klaviyo keys on the phone number's country code; Redo's country is the customer's profile/location country — verify the split in the Redo flow builder.`,
  });

  return {
    type: "customer_attribute",
    whereCondition: {
      type: "token",
      dimension: "country",
      comparison: {
        type: "token",
        operator: redoOperator,
        values,
      },
    },
  };
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

// ---------- Klaviyo profile-marketing-consent → Redo CustomerAttribute ----------
//
// Klaviyo shape (per Ueiu86 abandoned-cart fixture):
//   { type: "profile-marketing-consent",
//     consent: { channel: "sms" | "email",
//                can_receive_marketing: boolean,
//                consent_status: { subscription: "subscribed" | ..., filters: ... } } }
//
// Redo equivalents (from segment-types.ts CustomerCharacteristicType):
//   - SUBSCRIBED_TO_SMS   ("subscribed-to-sms")    — strict opt-in
//   - SUBSCRIBED_TO_EMAIL ("subscribed-to-email")  — strict opt-in
//   - CAN_RECEIVE_EMAIL_MARKETING                  — broader (has email + not unsubscribed)
//
// V1: ignore can_receive_marketing/filters and translate only the strict
// "is subscribed" form. consent_status.subscription === "subscribed" maps
// to BOOLEAN value=true; anything else (unsubscribed, never_subscribed)
// maps to value=false — i.e. "is NOT subscribed". Anything that doesn't
// fit (e.g. an email-channel rule with subscription=null but
// can_receive_marketing=false, or a channel we don't recognize) emits
// a warning instead.
function translateProfileMarketingConsentCondition(
  c: any,
  warnings: ParseWarning[],
  actionId: string,
): unknown | null {
  const channel = c.consent?.channel;
  const subscription = c.consent?.consent_status?.subscription;

  let dimension: "subscribed-to-sms" | "subscribed-to-email" | null = null;
  if (channel === "sms") dimension = "subscribed-to-sms";
  else if (channel === "email") dimension = "subscribed-to-email";

  if (!dimension) {
    warnings.push({
      kind: "requires-review",
      actionId,
      message: `profile-marketing-consent on channel "${channel ?? "?"}" not supported — manual config required`,
    });
    return null;
  }

  // Klaviyo's `subscription` enum has several values (subscribed,
  // unsubscribed, never_subscribed, etc.). Redo's only knob is BOOLEAN, so
  // treat anything other than `subscribed` as `value: false`.
  const value = subscription === "subscribed";

  return {
    type: "customer_attribute",
    whereCondition: {
      type: "boolean",
      dimension,
      comparison: { type: "boolean", value },
    },
  };
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
      case "profile-property": {
        // phone-country-code maps cleanly to Redo's country dimension;
        // anything else falls back to the manual-config placeholder.
        const phoneCountry = translatePhoneCountryCodeCondition(kc, warnings, action.id);
        if (phoneCountry) {
          redoConditions.push(phoneCountry);
        } else {
          profilePropertyPlaceholder(kc, warnings, action.id);
        }
        break;
      }
      case "profile-group-membership":
        profileGroupMembershipPlaceholder(kc, warnings, action.id);
        break;
      case "profile-marketing-consent": {
        const rc = translateProfileMarketingConsentCondition(kc, warnings, action.id);
        if (rc) redoConditions.push(rc);
        break;
      }
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

// ---------- Klaviyo flow-level `definition.profile_filter` → Redo skip ----------
//
// Klaviyo flows can carry a top-level `profile_filter` that says "ONLY run
// this flow for profiles matching these conditions" (e.g. customers who
// have placed 0 orders). The flow-action graph parser doesn't touch this
// — it lives at `definition.profile_filter`, not on any action.
//
// Redo's equivalent: a SKIP condition on the trigger step
// (`trigger.skipConditions[]`). Skip semantics are the LOGICAL INVERSE of
// Klaviyo's include filter:
//
//   Klaviyo: "run if (g1) OR (g2)"      where each group is c1 AND c2 ...
//   Redo:    "skip if NOT((g1) OR (g2))"
//            = "skip if NOT(g1) AND NOT(g2)"     De Morgan
//            = "skip if (NOT c1 OR NOT c2 OR ...) AND (NOT c1' OR ...)"
//
// V1 handles single-group profile-metric conditions fully (invert each
// operator, mode flips from AND→OR). Other condition types
// (profile-marketing-consent, profile-property, profile-group-membership)
// warn-only because their inversion requires per-type logic the per-
// action translator hasn't generalized to negation. Multi-group (OR'd
// groups) warns and processes only the first group. Per memory
// `feedback_flow_status_mapping`, imported flows land inactive regardless,
// so an imperfect translation can't accidentally fire.

const INVERT_KLAVIYO_OPERATOR: Record<string, string> = {
  "equals": "not-equals",
  "not-equals": "equals",
  "greater-than": "less-than-or-equal",
  "greater-than-or-equal": "less-than",
  "less-than": "greater-than-or-equal",
  "less-than-or-equal": "greater-than",
};

function invertKlaviyoCondition(c: any): any {
  const op = c.measurement_filter?.operator;
  if (!op || !(op in INVERT_KLAVIYO_OPERATOR)) return c;
  return {
    ...c,
    measurement_filter: {
      ...c.measurement_filter,
      operator: INVERT_KLAVIYO_OPERATOR[op],
    },
  };
}

function translateKlaviyoCondition(
  kc: any,
  metrics: MetricLookup,
  warnings: ParseWarning[],
): unknown | null {
  const inverted = invertKlaviyoCondition(kc);
  switch (inverted.type) {
    case "profile-metric":
      return translateProfileMetricCondition(
        inverted,
        metrics,
        warnings,
        "flow-profile-filter",
      );
    case "profile-marketing-consent":
    case "profile-property":
    case "profile-group-membership":
    case "profile-not-in-flow":
      warnings.push({
        kind: "requires-review",
        message: `flow profile_filter condition type "${inverted.type}" not yet translated — manual config required in the Redo flow builder`,
      });
      return null;
    default:
      warnings.push({
        kind: "requires-review",
        message: `flow profile_filter condition type "${inverted.type}" not recognized — manual config required`,
      });
      return null;
  }
}

export function translateFlowProfileFilter(
  profileFilter: unknown,
  metrics: MetricLookup,
  warnings: ParseWarning[],
): unknown | null {
  const pf = profileFilter as any;
  const groups = pf?.condition_groups ?? [];
  if (groups.length === 0) return null;

  // De Morgan from Klaviyo "include" to Redo "skip":
  //
  //   Klaviyo: include if G1 OR G2 OR ...   where each Gn is c1 AND c2 ...
  //   Redo:    skip    if NOT(G1) AND NOT(G2) AND ...
  //                    where NOT(Gn) = NOT c1 OR NOT c2 OR ...
  //
  // Redo's inline-segment supports a flat `mode: "AND"|"OR"` — not nested
  // groups. So:
  //
  //  - Single group → emit one inline-segment with mode "OR" containing
  //    each condition inverted (NOT of an AND-group).
  //  - Multi-group where every group has exactly 1 condition → flatten
  //    to one inline-segment with mode "AND" and each inverted condition.
  //  - Multi-group with any multi-condition group → would need nested
  //    AND-of-ORs which inline-segment can't express. Warn + process the
  //    first group only.
  //
  // Per memory `feedback_flow_status_mapping`, imported flows land
  // inactive — an imperfect filter still gets reviewed before going live.

  const everyGroupHasOneCondition = groups.every(
    (g: any) => (g.conditions ?? []).length === 1,
  );

  if (groups.length === 1) {
    const klaviyoConditions = groups[0].conditions ?? [];
    if (klaviyoConditions.length === 0) return null;
    const redoConditions: unknown[] = [];
    for (const kc of klaviyoConditions) {
      const rc = translateKlaviyoCondition(kc, metrics, warnings);
      if (rc) redoConditions.push(rc);
    }
    if (redoConditions.length === 0) return null;
    return {
      dataSource: "inline-segment",
      inlineSegment: {
        // De Morgan: AND inside Klaviyo include → OR for the inverted skip.
        mode: "OR",
        conditions: redoConditions,
      },
    };
  }

  if (everyGroupHasOneCondition) {
    const redoConditions: unknown[] = [];
    for (const g of groups) {
      const kc = g.conditions[0];
      const rc = translateKlaviyoCondition(kc, metrics, warnings);
      if (rc) redoConditions.push(rc);
    }
    if (redoConditions.length === 0) return null;
    return {
      dataSource: "inline-segment",
      inlineSegment: {
        // De Morgan: OR across Klaviyo groups → AND for the inverted skip.
        mode: "AND",
        conditions: redoConditions,
      },
    };
  }

  // Multi-group with at least one multi-condition group — can't flatten.
  warnings.push({
    kind: "requires-review",
    message: `flow profile_filter has ${groups.length} OR'd groups where at least one group has multiple AND'd conditions — V1 migrates only the first group; the rest need manual config in the Redo flow builder`,
  });
  const klaviyoConditions = groups[0].conditions ?? [];
  const redoConditions: unknown[] = [];
  for (const kc of klaviyoConditions) {
    const rc = translateKlaviyoCondition(kc, metrics, warnings);
    if (rc) redoConditions.push(rc);
  }
  if (redoConditions.length === 0) return null;
  return {
    dataSource: "inline-segment",
    inlineSegment: { mode: "OR", conditions: redoConditions },
  };
}

// Substitutions for Klaviyo conditions that have no native Redo dimension but a
// defensible proxy. Each returns a CondResult tagged `substituted` (with a
// human "here's our logic instead" string) or `unsupported` (no proxy).
//
// The proxies are deliberately rough — the verify step (getSegmentCount vs
// Klaviyo's profile_count, ±10%) is the safety net, and count-threshold
// substitutions are auto-tuned there to land on the original population.

import type {
  ProfilePostalCodeDistanceCondition,
  ProfilePredictiveAnalyticsCondition,
  ProfileRegionCondition,
} from "./klaviyo-types.js";
import type { CondResult } from "./result-types.js";
import type {
  CustomerActivityCondition,
  NumericOperator,
  QueryCondition,
} from "./redo-types.js";
import { KLAVIYO_NUMERIC_OP_TO_REDO } from "./maps.js";

export interface SubstitutionOptions {
  /** Merchant average order value — initial guess for CLV→order-count. The
   *  verify step auto-tunes the actual threshold, so this only seeds the math
   *  and the human explanation. Defaults to 100. */
  aov?: number;
}

const DEFAULT_AOV = 100;

const OP_WORD: Record<NumericOperator, string> = {
  gte: "at least",
  gt: "more than",
  lte: "at most",
  lt: "fewer than",
  eq: "exactly",
  neq: "not",
};

// EU member-state ISO-3166-1 alpha-2 codes (27).
const EU_COUNTRIES = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE",
];

const CLV_DIMENSIONS = new Set([
  "predicted_clv",
  "historic_clv",
  "total_clv",
  "expected_clv",
  "predicted_total_clv",
]);
const AOV_DIMENSIONS = new Set(["average_order_value", "predicted_aov"]);
const CHURN_DIMENSIONS = new Set(["churn_probability", "churn_risk"]);
const ORDER_COUNT_DIMENSIONS = new Set([
  "predicted_number_of_orders",
  "historic_number_of_orders",
]);
// Resolved 2026-06-16: lapsed-buyer proxy (no order in N days), N auto-tuned.
const LAPSED_DIMENSIONS = new Set([
  "expected_date_of_next_order",
  "expected_date_of_next_purchase",
]);
const UNSUPPORTED_DIMENSIONS = new Set([
  "predicted_gender",
  "channel_affinity",
  "average_days_between_orders",
  "average_time_between_orders",
]);

function orderPlaced(
  count: CustomerActivityCondition["count"],
  timeframe: CustomerActivityCondition["timeframe"],
  eventFilters: CustomerActivityCondition["event_filters"] = [],
): CustomerActivityCondition {
  return {
    type: "customer_activity",
    event: "order-placed",
    count,
    timeframe,
    event_filters: eventFilters,
  };
}

export function substitutePredictiveAnalytics(
  c: ProfilePredictiveAnalyticsCondition,
  opts: SubstitutionOptions,
): CondResult {
  const dim = c.dimension;
  const klOp = c.filter?.operator;
  const value = Number(c.filter?.value ?? 0);
  const redoOp = klOp ? KLAVIYO_NUMERIC_OP_TO_REDO[klOp] : undefined;

  if (UNSUPPORTED_DIMENSIONS.has(dim)) {
    return {
      kind: "unsupported",
      dropped: {
        klaviyoType: "profile-predictive-analytics",
        dimension: dim,
        reason: `Redo has no equivalent for predictive "${dim}" and no defensible proxy — condition dropped.`,
      },
    };
  }

  // CLV ≈ number of orders × AOV  →  order-placed count {op} ceil(CLV / AOV)
  if (CLV_DIMENSIONS.has(dim)) {
    if (!redoOp) return unsupportedOp("profile-predictive-analytics", dim, klOp);
    const aov = opts.aov && opts.aov > 0 ? opts.aov : DEFAULT_AOV;
    const n = Math.max(1, Math.ceil(value / aov));
    const condition = orderPlaced(
      { operator: redoOp, value: n },
      { type: "all-time", options: null },
    );
    return {
      kind: "substituted",
      condition,
      sub: {
        klaviyoType: "profile-predictive-analytics",
        klaviyoSummary: `${dim} ${klOp} ${value}`,
        redoLogic: `customers with ${OP_WORD[redoOp]} ${n} orders all-time (CLV $${value} ÷ AOV $${aov})`,
        assumptions: { aov },
        tunable: "order-count",
        conditionRef: condition,
      },
    };
  }

  // Predicted/historic order count maps straight to order count (no AOV).
  if (ORDER_COUNT_DIMENSIONS.has(dim)) {
    if (!redoOp) return unsupportedOp("profile-predictive-analytics", dim, klOp);
    const n = Math.max(0, Math.round(value));
    const condition = orderPlaced(
      { operator: redoOp, value: n },
      { type: "all-time", options: null },
    );
    return {
      kind: "substituted",
      condition,
      sub: {
        klaviyoType: "profile-predictive-analytics",
        klaviyoSummary: `${dim} ${klOp} ${value}`,
        redoLogic: `customers with ${OP_WORD[redoOp]} ${n} orders all-time`,
        assumptions: {},
        tunable: "order-count",
        conditionRef: condition,
      },
    };
  }

  // AOV ≈ has placed an order whose total crosses the threshold.
  if (AOV_DIMENSIONS.has(dim)) {
    if (!redoOp) return unsupportedOp("profile-predictive-analytics", dim, klOp);
    const condition = orderPlaced(
      { operator: "gt", value: 0 },
      { type: "all-time", options: null },
      [
        {
          type: "numeric",
          dimension: "order_total",
          comparison: { type: "numeric", operator: redoOp, value },
        },
      ],
    );
    return {
      kind: "substituted",
      condition,
      sub: {
        klaviyoType: "profile-predictive-analytics",
        klaviyoSummary: `${dim} ${klOp} ${value}`,
        redoLogic: `customers with an order whose total is ${OP_WORD[redoOp]} $${value}`,
        assumptions: {},
        tunable: null,
        conditionRef: condition,
      },
    };
  }

  // Churn risk ≈ no order in the last N days (default 90, auto-tuned).
  if (CHURN_DIMENSIONS.has(dim)) {
    return substituteLapsed("profile-predictive-analytics", `${dim} ${klOp ?? ""} ${value}`.trim());
  }

  // Lapsed-buyer (expected next-order date) ≈ no order in the last N days.
  if (LAPSED_DIMENSIONS.has(dim)) {
    return substituteLapsed("profile-predictive-analytics", `${dim} ${klOp ?? ""} ${value}`.trim());
  }

  return {
    kind: "unsupported",
    dropped: {
      klaviyoType: "profile-predictive-analytics",
      dimension: dim,
      reason: `Unrecognized predictive dimension "${dim}" — no proxy available.`,
    },
  };
}

// "Lapsed buyer" proxy: no order placed in the last N days (default 90), with
// N auto-tuned to the Klaviyo population. Used for predictive churn /
// expected-next-order dimensions AND the `last_active` profile property.
export function substituteLapsed(klaviyoType: string, klaviyoSummary: string): CondResult {
  const days = 90;
  const condition = orderPlaced(
    { operator: "eq", value: 0 },
    { type: "before-now-relative", options: { value: days, units: "day" } },
  );
  return {
    kind: "substituted",
    condition,
    sub: {
      klaviyoType,
      klaviyoSummary,
      redoLogic: `customers with no orders in the last ${days} days`,
      assumptions: {},
      tunable: "churn-days",
      conditionRef: condition,
    },
  };
}

export function substituteRegion(c: ProfileRegionCondition): CondResult {
  const op = c.in_region === false ? "NONE" : "ANY";
  const region = c.region_id;
  if (region === "united_states") {
    // Single country → exact via the country dimension.
    const condition: QueryCondition = {
      type: "customer_attribute",
      whereCondition: {
        type: "token",
        dimension: "country",
        comparison: { type: "token", operator: op, values: ["US"] },
      },
    };
    return { kind: "exact", condition };
  }
  if (region === "european_union") {
    const condition: QueryCondition = {
      type: "customer_attribute",
      whereCondition: {
        type: "token",
        dimension: "country",
        comparison: { type: "token", operator: op, values: EU_COUNTRIES },
      },
    };
    return {
      kind: "substituted",
      condition,
      sub: {
        klaviyoType: "profile-region",
        klaviyoSummary: `${c.in_region === false ? "not in" : "in"} ${region}`,
        redoLogic: `country ${op === "NONE" ? "is none of" : "is any of"} the 27 EU member states`,
        assumptions: {},
        tunable: null,
        conditionRef: condition,
      },
    };
  }
  return {
    kind: "unsupported",
    dropped: {
      klaviyoType: "profile-region",
      dimension: region,
      reason: `Unknown Klaviyo region "${region}" — no country mapping.`,
    },
  };
}

export function substitutePostalCodeDistance(
  c: ProfilePostalCodeDistanceCondition,
): CondResult {
  // Redo has proximity-to-CITY, not proximity-to-postal-code, and no geocoder
  // here to turn a ZIP into a city/state. Drop with an explanation.
  return {
    kind: "unsupported",
    dropped: {
      klaviyoType: "profile-postal-code-distance",
      reason: `Redo supports distance-to-city, not distance-to-postal-code (${c.postal_code ?? "?"} ${c.country_code ?? ""}). Recreate manually as a city-proximity condition.`,
    },
  };
}

function unsupportedOp(
  klaviyoType: string,
  dimension: string,
  op: string | undefined,
): CondResult {
  return {
    kind: "unsupported",
    dropped: {
      klaviyoType,
      dimension,
      reason: `Operator "${op ?? "?"}" on "${dimension}" isn't translatable to a Redo numeric comparison.`,
    },
  };
}

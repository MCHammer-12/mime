// Redo dynamic-segment output shape — the `conditions` payload accepted by the
// `createDynamicSegment` RPC (input: `{ name, conditions: SegmentQuery }`) and
// by `getSegmentCount` (`{ segment: SegmentQuery }`).
//
// Mirrors redoapp `redo/model/src/marketing/segments/segment-zod-schema.ts`
// (the ZOD shape — note `event` / `count:{operator,value}` / `event_filters` /
// `timeframe:{type,options}`, NOT the SegmentConditionBlock *interface* shape
// the flow CONDITION step uses). Field-name drift here = silent Zod 400s, so
// the smoke test asserts against these literals.
//
// Enums copied (not imported — redoapp isn't a dep of mime) from:
//   - segment-types.ts (ConjunctionMode, CustomerActivityType, ActivityCountType,
//     CustomerCharacteristicType, SegmentConditionType)
//   - segment-where-condition.ts (WhereConditionDataType, *CompareOperators)
//   - segment-timeframe.ts (TimeframeConditionType, TimeframeUnit)

export type Conjunction = "AND" | "OR";

export interface SegmentQuery {
  conjunction: Conjunction;
  conditionBlocks: ConditionBlock[];
}

export interface ConditionBlock {
  operator: Conjunction;
  conditions: QueryCondition[];
}

export type QueryCondition =
  | CustomerAttributeCondition
  | CustomerActivityCondition
  | CustomEventCondition;

// ---- customer_attribute ----------------------------------------------------

export interface CustomerAttributeCondition {
  type: "customer_attribute";
  whereCondition: WhereCondition;
}

// ---- customer_activity -----------------------------------------------------

export interface CustomerActivityCondition {
  type: "customer_activity";
  event: CustomerActivityType;
  count: EventCount;
  timeframe: Timeframe;
  event_filters: WhereCondition[];
}

export interface CustomEventCondition {
  type: "custom_event";
  eventName: string;
  count: EventCount;
  timeframe: Timeframe;
  property_filters: WhereCondition[];
}

// Zod count shape: { operator, value } (NumericCompareOperator), NOT {type,n}.
export interface EventCount {
  operator: NumericOperator;
  value: number;
}

// CustomerActivityType (Shopify values — Klaviyo merchants are Shopify).
export type CustomerActivityType =
  | "received-email"
  | "opened-email"
  | "clicked-email"
  | "received-text"
  | "clicked-text"
  | "viewed-product"
  | "added-product-to-cart"
  | "order-placed"
  | "checkout-started"
  | "active-on-site"
  | "collection-viewed"
  | "return-processed"
  | "subscribed-to-back-in-stock"
  | "triggered-back-in-stock-notification";

// CustomerCharacteristicType
export type CustomerCharacteristic =
  | "subscribed-to-email"
  | "can-receive-email-marketing"
  | "subscribed-to-sms"
  | "created-time"
  | "customer-tags"
  | "static-segment-membership"
  | "return-rate-value"
  | "return-rate-count"
  | "birthday"
  | "custom-fields"
  | "phone-number-area-code"
  | "state-province"
  | "country"
  | "city"
  | "proximity-to-city"
  | "enrolled-in-loyalty-lion"
  | "email-address"
  | "customer-name";

// ---- where conditions ------------------------------------------------------

export type WhereCondition =
  | TokenWhere
  | NumericWhere
  | BooleanWhere
  | TokenHierarchyWhere
  | TokenListWhere
  | StringWhere
  | FullDateWhere
  | AnnualDateWhere;

export type NumericOperator = "eq" | "gt" | "lt" | "gte" | "lte" | "neq";
export type TokenOperator = "ANY" | "NONE";
export type StringOperator =
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with";
export type ListOperator = "any" | "none" | "all";

export interface TokenWhere {
  type: "token";
  dimension: string;
  comparison: { type: "token"; operator: TokenOperator; values: string[] };
}

export interface NumericWhere {
  type: "numeric";
  dimension: string;
  comparison: { type: "numeric"; operator: NumericOperator; value: number };
}

export interface BooleanWhere {
  type: "boolean";
  dimension: string;
  comparison: { type: "boolean"; value: boolean };
}

export interface TokenHierarchyWhere {
  type: "token-hierarchy";
  dimension: string;
  comparison: {
    type: "token";
    operator: TokenOperator;
    prerequisiteValues: string[];
    values: string[];
  };
}

export interface TokenListWhere {
  type: "token_list";
  dimension: string;
  comparison: { type: "list"; operator: ListOperator; values: string[] };
}

export interface StringWhere {
  type: "string";
  dimension: string;
  comparison: { type: "string"; operator: StringOperator; value: string };
}

// Date characteristics (created-time = full date, birthday = annual date). The
// comparison is the same `{type, options}` timeframe shape used by activities.
export interface FullDateWhere {
  type: "date";
  dimension: string;
  comparison: Timeframe;
}

export interface AnnualDateWhere {
  type: "date-annual";
  dimension: string;
  comparison: Timeframe;
}

// ---- timeframe -------------------------------------------------------------
// Zod shape wraps params in `options` (segment-timeframe-zod-schema.ts).

export type TimeframeUnit = "hour" | "day" | "week" | "month";

export type Timeframe =
  | { type: "all-time"; options: null }
  | { type: "today"; options: null }
  | { type: "before-now-relative"; options: { value: number; units: TimeframeUnit } }
  | { type: "before-relative"; options: { value: number; units: TimeframeUnit } }
  | { type: "after"; options: { date: string } }
  | { type: "before"; options: { date: string } }
  | { type: "on"; options: { date: string } }
  | {
      type: "between-relative";
      options: { start: number; end: number; units: TimeframeUnit };
    }
  | { type: "between-dates"; options: { range: [string, string] } };

import type { MetricLookup } from "../extract-metrics.js";
import {
  MarketingTriggerKey,
  OrderTrackingTriggerKey,
  ReviewsTriggerKey,
  SchemaType,
  type FlowCategory,
  type KlaviyoFlow,
  type KlaviyoTrigger,
  type ParseWarning,
  type TriggerKey,
} from "./types.js";

export interface TriggerResolution {
  key: TriggerKey;
  schemaType: SchemaType;
  category: FlowCategory;
  // Auto-generated skip condition the importer will emit on the trigger step.
  // UI auto-inserts this on abandonment flows; repo create does not.
  autoSkipAbandonmentField?: "isCartAbandoned" | "isBrowseAbandoned" | "isCheckoutAbandoned";
  // Klaviyo "Viewed Product" and "Active on Site" both collapse to Redo's
  // Browse Abandonment trigger. Both would fire on every browse-abandon event
  // otherwise — the customer gets two emails. Tag the source so parseFlow can
  // emit a mutually-exclusive viewed-product skip condition:
  //   viewed-product   → skip if customer has NOT viewed-product in window
  //   active-on-site   → skip if customer HAS viewed-product in window
  klaviyoSource?: "viewed-product" | "active-on-site";
}

// Well-known Klaviyo metric names → Redo trigger. Keys are case-insensitive.
// Merchants customize metric NAMES rarely but metric IDs always — the name is
// the stable key. See reference PDF §2 and project_coverage_gaps memory.
//
// Includes one cross-category mapping: Klaviyo "Placed Order" lands on the
// Order tracking ORDER_CREATED trigger (post-purchase emails, review asks,
// cross-sell, winbacks). Redo doesn't expose post-purchase as a Marketing
// trigger, so we drop into the order-tracking schema.
const METRIC_NAME_MAP: Record<
  string,
  { key: TriggerKey; schemaType: SchemaType; category: FlowCategory }
> = {
  // Klaviyo's "Started Checkout" → Redo CHECKOUT abandonment (strict semantics).
  // This REVERSES the 2026-05-08 decision (PR #43) that mapped it to CART
  // abandonment on merchant-naming grounds ("merchants call it abandoned cart").
  // Michael's call 2026-06-12: semantic correctness wins — Started Checkout is
  // checkout abandonment — driven by reviewer feedback (Rufskin HseqBM, SHOC
  // R3uzmb wanted Checkout Abandonment). `added to cart` below stays CART
  // abandonment; only the two Started-Checkout aliases flip. The key flip also
  // auto-selects the isCheckoutAbandoned skip field (AUTO_SKIP_ABANDONMENT_FIELD).
  "started checkout":   { key: MarketingTriggerKey.CHECKOUT_ABANDONED, schemaType: SchemaType.MARKETING_CHECKOUT_ABANDONMENT, category: "Marketing" },
  "checkout started":   { key: MarketingTriggerKey.CHECKOUT_ABANDONED, schemaType: SchemaType.MARKETING_CHECKOUT_ABANDONMENT, category: "Marketing" },
  "added to cart":      { key: MarketingTriggerKey.CART_ABANDONED,     schemaType: SchemaType.MARKETING_CART_ABANDONMENT,     category: "Marketing" },
  "viewed product":     { key: MarketingTriggerKey.BROWSE_ABANDONED,   schemaType: SchemaType.MARKETING_BROWSE_ABANDONMENT,   category: "Marketing" },
  "active on site":     { key: MarketingTriggerKey.BROWSE_ABANDONED,   schemaType: SchemaType.MARKETING_BROWSE_ABANDONMENT,   category: "Marketing" },
  "back in stock":      { key: MarketingTriggerKey.BACK_IN_STOCK,      schemaType: SchemaType.MARKETING_BACK_IN_STOCK,        category: "Marketing" },
  "low inventory":      { key: MarketingTriggerKey.LOW_INVENTORY,      schemaType: SchemaType.MARKETING_LOW_INVENTORY,        category: "Marketing" },
  "warranty registration": { key: MarketingTriggerKey.WARRANTY_REGISTRATION, schemaType: SchemaType.MARKETING_WARRANTY_REGISTRATION, category: "Marketing" },
  "placed order":       { key: OrderTrackingTriggerKey.ORDER_CREATED,  schemaType: SchemaType.ORDER_TRACKING,                 category: "Order tracking" },
  "ordered product":    { key: OrderTrackingTriggerKey.ORDER_CREATED,  schemaType: SchemaType.ORDER_TRACKING,                 category: "Order tracking" },

  // ─── Order Tracking — full set ────────────────────────────────────
  // Klaviyo's shipment events vary by source (Shopify Klaviyo integration,
  // Aftership, ShipBob, etc.). The names here cover the common patterns;
  // add aliases as new merchants surface variants.
  // All share SchemaType.ORDER_TRACKING — only `key` distinguishes them.
  "fulfilled order":              { key: OrderTrackingTriggerKey.ORDER_FULFILLED,                  schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "marked as fulfilled":          { key: OrderTrackingTriggerKey.ORDER_FULFILLED,                  schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  // "Order shipped" = Shopify fires when fulfillment posts tracking; usually
  // means "label created / carrier accepted" — closer to ORDER_FULFILLED than
  // ORDER_IN_TRANSIT in Klaviyo's semantics.
  "order shipped":                { key: OrderTrackingTriggerKey.ORDER_FULFILLED,                  schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "shipment pre-transit":         { key: OrderTrackingTriggerKey.ORDER_PRE_TRANSIT,                schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "pre-transit":                  { key: OrderTrackingTriggerKey.ORDER_PRE_TRANSIT,                schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "shipment in transit":          { key: OrderTrackingTriggerKey.ORDER_IN_TRANSIT,                 schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "in transit":                   { key: OrderTrackingTriggerKey.ORDER_IN_TRANSIT,                 schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "shipment out for delivery":    { key: OrderTrackingTriggerKey.ORDER_OUT_FOR_DELIVERY,           schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "out for delivery":             { key: OrderTrackingTriggerKey.ORDER_OUT_FOR_DELIVERY,           schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "shipment delivered":           { key: OrderTrackingTriggerKey.ORDER_DELIVERED,                  schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "order delivered":              { key: OrderTrackingTriggerKey.ORDER_DELIVERED,                  schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "shipment available for pickup": { key: OrderTrackingTriggerKey.ORDER_AVAILABLE_FOR_PICKUP,      schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "available for pickup":          { key: OrderTrackingTriggerKey.ORDER_AVAILABLE_FOR_PICKUP,      schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "available for pickup (carrier)": { key: OrderTrackingTriggerKey.ORDER_AVAILABLE_FOR_PICKUP_CARRIER, schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "shipment stalled in transit":  { key: OrderTrackingTriggerKey.ORDER_STALLED_IN_TRANSIT,         schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "stalled in transit":           { key: OrderTrackingTriggerKey.ORDER_STALLED_IN_TRANSIT,         schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "shipment stalled in fulfillment": { key: OrderTrackingTriggerKey.ORDER_STALLED_IN_FULFILLMENT,  schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "stalled in fulfillment":       { key: OrderTrackingTriggerKey.ORDER_STALLED_IN_FULFILLMENT,     schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "shipment delayed":             { key: OrderTrackingTriggerKey.ORDER_DELAYED,                    schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "order delayed":                { key: OrderTrackingTriggerKey.ORDER_DELAYED,                    schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "shipment arriving early":      { key: OrderTrackingTriggerKey.ORDER_ARRIVING_EARLY,             schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "arriving early":               { key: OrderTrackingTriggerKey.ORDER_ARRIVING_EARLY,             schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "shipment return to sender":    { key: OrderTrackingTriggerKey.ORDER_RETURN_TO_SENDER,           schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "return to sender":             { key: OrderTrackingTriggerKey.ORDER_RETURN_TO_SENDER,           schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "shipment delivery attempted":  { key: OrderTrackingTriggerKey.ORDER_DELIVERY_ATTEMPTED,         schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "delivery attempted":           { key: OrderTrackingTriggerKey.ORDER_DELIVERY_ATTEMPTED,         schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "shipment failure":             { key: OrderTrackingTriggerKey.ORDER_DELIVERY_FAILURE,           schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "delivery failure":             { key: OrderTrackingTriggerKey.ORDER_DELIVERY_FAILURE,           schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "shipment cancelled":           { key: OrderTrackingTriggerKey.ORDER_SHIPMENT_CANCELLED,         schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "cancelled order":              { key: OrderTrackingTriggerKey.ORDER_SHIPMENT_CANCELLED,         schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },
  "shipment error":               { key: OrderTrackingTriggerKey.ORDER_SHIPMENT_ERROR,             schemaType: SchemaType.ORDER_TRACKING, category: "Order tracking" },

  // ─── Reviews (generic — non-Yotpo platforms) ──────────────────────
  // Yotpo-specific events stay on the Integration category (see
  // YOTPO_REVIEW_CREATED entries below). Anything else routes here.
  // Plain "submitted review" used to map to Yotpo (Integration); routing it
  // through the generic Reviews trigger is what merchants actually want for
  // non-Yotpo review platforms like Judge.me, Loox, Okendo, Stamped.
  "review submitted":             { key: ReviewsTriggerKey.REVIEW_SUBMITTED,                       schemaType: SchemaType.REVIEWS,        category: "Reviews" },
  "submitted review":             { key: ReviewsTriggerKey.REVIEW_SUBMITTED,                       schemaType: SchemaType.REVIEWS,        category: "Reviews" },
  "review created":               { key: ReviewsTriggerKey.REVIEW_SUBMITTED,                       schemaType: SchemaType.REVIEWS,        category: "Reviews" },
  "judge.me review created":      { key: ReviewsTriggerKey.REVIEW_SUBMITTED,                       schemaType: SchemaType.REVIEWS,        category: "Reviews" },
  "judge.me - review created":    { key: ReviewsTriggerKey.REVIEW_SUBMITTED,                       schemaType: SchemaType.REVIEWS,        category: "Reviews" },
  "loox review submitted":        { key: ReviewsTriggerKey.REVIEW_SUBMITTED,                       schemaType: SchemaType.REVIEWS,        category: "Reviews" },
  "okendo review submitted":      { key: ReviewsTriggerKey.REVIEW_SUBMITTED,                       schemaType: SchemaType.REVIEWS,        category: "Reviews" },
  "stamped review created":       { key: ReviewsTriggerKey.REVIEW_SUBMITTED,                       schemaType: SchemaType.REVIEWS,        category: "Reviews" },

  // ─── Yotpo Loyalty (Klaviyo integration) ──────────────────────────
  // Yotpo's Klaviyo integration emits events under both the legacy "Swell"
  // brand name and the current "Loyalty" name; merchant accounts vintage
  // varies, so we map both prefixes to the same Redo trigger. Source
  // names compiled from Yotpo Loyalty's Klaviyo integration documentation;
  // confirm exact names via `extract-metrics.ts` for any new Yotpo merchant.
  "yotpo swell loyalty: tier reached":     { key: SchemaType.YOTPO_LOYALTY_TIER_EARNED,           schemaType: SchemaType.YOTPO_LOYALTY_TIER_EARNED,           category: "Integration" },
  "yotpo loyalty: tier reached":           { key: SchemaType.YOTPO_LOYALTY_TIER_EARNED,           schemaType: SchemaType.YOTPO_LOYALTY_TIER_EARNED,           category: "Integration" },
  "yotpo loyalty tier earned":             { key: SchemaType.YOTPO_LOYALTY_TIER_EARNED,           schemaType: SchemaType.YOTPO_LOYALTY_TIER_EARNED,           category: "Integration" },
  "yotpo swell loyalty: tier downgraded":  { key: SchemaType.YOTPO_LOYALTY_TIER_LOST,             schemaType: SchemaType.YOTPO_LOYALTY_TIER_LOST,             category: "Integration" },
  "yotpo loyalty: tier downgraded":        { key: SchemaType.YOTPO_LOYALTY_TIER_LOST,             schemaType: SchemaType.YOTPO_LOYALTY_TIER_LOST,             category: "Integration" },
  "yotpo loyalty tier lost":               { key: SchemaType.YOTPO_LOYALTY_TIER_LOST,             schemaType: SchemaType.YOTPO_LOYALTY_TIER_LOST,             category: "Integration" },
  "yotpo swell loyalty: earned points":    { key: SchemaType.YOTPO_LOYALTY_POINTS_EARNED,         schemaType: SchemaType.YOTPO_LOYALTY_POINTS_EARNED,         category: "Integration" },
  "yotpo loyalty: earned points":          { key: SchemaType.YOTPO_LOYALTY_POINTS_EARNED,         schemaType: SchemaType.YOTPO_LOYALTY_POINTS_EARNED,         category: "Integration" },
  "yotpo loyalty points earned":           { key: SchemaType.YOTPO_LOYALTY_POINTS_EARNED,         schemaType: SchemaType.YOTPO_LOYALTY_POINTS_EARNED,         category: "Integration" },
  "yotpo swell loyalty: points expiration reminder": { key: SchemaType.YOTPO_LOYALTY_EXPIRATION_REMINDER, schemaType: SchemaType.YOTPO_LOYALTY_EXPIRATION_REMINDER, category: "Integration" },
  "yotpo loyalty: points expiration reminder":       { key: SchemaType.YOTPO_LOYALTY_EXPIRATION_REMINDER, schemaType: SchemaType.YOTPO_LOYALTY_EXPIRATION_REMINDER, category: "Integration" },
  "yotpo loyalty expiration reminder":               { key: SchemaType.YOTPO_LOYALTY_EXPIRATION_REMINDER, schemaType: SchemaType.YOTPO_LOYALTY_EXPIRATION_REMINDER, category: "Integration" },
  "yotpo swell loyalty: points reminder":  { key: SchemaType.YOTPO_LOYALTY_POINTS_REMINDER,       schemaType: SchemaType.YOTPO_LOYALTY_POINTS_REMINDER,       category: "Integration" },
  "yotpo loyalty: points reminder":        { key: SchemaType.YOTPO_LOYALTY_POINTS_REMINDER,       schemaType: SchemaType.YOTPO_LOYALTY_POINTS_REMINDER,       category: "Integration" },
  "yotpo loyalty points reminder":         { key: SchemaType.YOTPO_LOYALTY_POINTS_REMINDER,       schemaType: SchemaType.YOTPO_LOYALTY_POINTS_REMINDER,       category: "Integration" },
  "yotpo swell loyalty: redemption reminder": { key: SchemaType.YOTPO_LOYALTY_REDEMPTION_REMINDER, schemaType: SchemaType.YOTPO_LOYALTY_REDEMPTION_REMINDER, category: "Integration" },
  "yotpo loyalty: redemption reminder":       { key: SchemaType.YOTPO_LOYALTY_REDEMPTION_REMINDER, schemaType: SchemaType.YOTPO_LOYALTY_REDEMPTION_REMINDER, category: "Integration" },
  "yotpo loyalty redemption reminder":        { key: SchemaType.YOTPO_LOYALTY_REDEMPTION_REMINDER, schemaType: SchemaType.YOTPO_LOYALTY_REDEMPTION_REMINDER, category: "Integration" },
  "yotpo swell loyalty: redemption created":  { key: SchemaType.YOTPO_LOYALTY_REDEMPTION_CREATED, schemaType: SchemaType.YOTPO_LOYALTY_REDEMPTION_CREATED, category: "Integration" },
  "yotpo loyalty: redemption created":        { key: SchemaType.YOTPO_LOYALTY_REDEMPTION_CREATED, schemaType: SchemaType.YOTPO_LOYALTY_REDEMPTION_CREATED, category: "Integration" },
  "yotpo loyalty redemption created":         { key: SchemaType.YOTPO_LOYALTY_REDEMPTION_CREATED, schemaType: SchemaType.YOTPO_LOYALTY_REDEMPTION_CREATED, category: "Integration" },
  "yotpo swell loyalty: referral completed":  { key: SchemaType.YOTPO_LOYALTY_REFERRAL_COMPLETED, schemaType: SchemaType.YOTPO_LOYALTY_REFERRAL_COMPLETED, category: "Integration" },
  "yotpo loyalty: referral completed":        { key: SchemaType.YOTPO_LOYALTY_REFERRAL_COMPLETED, schemaType: SchemaType.YOTPO_LOYALTY_REFERRAL_COMPLETED, category: "Integration" },
  "yotpo loyalty referral completed":         { key: SchemaType.YOTPO_LOYALTY_REFERRAL_COMPLETED, schemaType: SchemaType.YOTPO_LOYALTY_REFERRAL_COMPLETED, category: "Integration" },
  "yotpo swell loyalty: referral shared":     { key: SchemaType.YOTPO_LOYALTY_REFERRAL_SHARED,    schemaType: SchemaType.YOTPO_LOYALTY_REFERRAL_SHARED,    category: "Integration" },
  "yotpo loyalty: referral shared":           { key: SchemaType.YOTPO_LOYALTY_REFERRAL_SHARED,    schemaType: SchemaType.YOTPO_LOYALTY_REFERRAL_SHARED,    category: "Integration" },
  "yotpo loyalty referral shared":            { key: SchemaType.YOTPO_LOYALTY_REFERRAL_SHARED,    schemaType: SchemaType.YOTPO_LOYALTY_REFERRAL_SHARED,    category: "Integration" },
  "yotpo swell loyalty: customer birthday":   { key: SchemaType.YOTPO_LOYALTY_CUSTOMER_BIRTHDAY,  schemaType: SchemaType.YOTPO_LOYALTY_CUSTOMER_BIRTHDAY,  category: "Integration" },
  "yotpo loyalty: customer birthday":         { key: SchemaType.YOTPO_LOYALTY_CUSTOMER_BIRTHDAY,  schemaType: SchemaType.YOTPO_LOYALTY_CUSTOMER_BIRTHDAY,  category: "Integration" },
  "yotpo loyalty customer birthday":          { key: SchemaType.YOTPO_LOYALTY_CUSTOMER_BIRTHDAY,  schemaType: SchemaType.YOTPO_LOYALTY_CUSTOMER_BIRTHDAY,  category: "Integration" },
  "yotpo swell loyalty: customer opt in":     { key: SchemaType.YOTPO_LOYALTY_OPT_IN,             schemaType: SchemaType.YOTPO_LOYALTY_OPT_IN,             category: "Integration" },
  "yotpo loyalty: customer opt in":           { key: SchemaType.YOTPO_LOYALTY_OPT_IN,             schemaType: SchemaType.YOTPO_LOYALTY_OPT_IN,             category: "Integration" },
  "yotpo loyalty opt in":                     { key: SchemaType.YOTPO_LOYALTY_OPT_IN,             schemaType: SchemaType.YOTPO_LOYALTY_OPT_IN,             category: "Integration" },

  // ─── Yotpo Reviews (Klaviyo integration) ──────────────────────────
  // Only Yotpo-prefixed events stay on the Integration category — plain
  // "submitted review" goes to the generic Reviews trigger above.
  "yotpo review created":  { key: SchemaType.YOTPO_REVIEW_CREATED, schemaType: SchemaType.YOTPO_REVIEW_CREATED, category: "Integration" },
  "yotpo: submitted review": { key: SchemaType.YOTPO_REVIEW_CREATED, schemaType: SchemaType.YOTPO_REVIEW_CREATED, category: "Integration" },
  "yotpo submitted review": { key: SchemaType.YOTPO_REVIEW_CREATED, schemaType: SchemaType.YOTPO_REVIEW_CREATED, category: "Integration" },
};

const COMMENTSOLD_VARIANTS: Record<
  MarketingTriggerKey,
  { key: MarketingTriggerKey; schemaType: SchemaType } | null
> = {
  [MarketingTriggerKey.CART_ABANDONED]: {
    key: MarketingTriggerKey.COMMENTSOLD_CART_ABANDONED,
    schemaType: SchemaType.MARKETING_COMMENTSOLD_CART_ABANDONMENT,
  },
  [MarketingTriggerKey.BROWSE_ABANDONED]: {
    key: MarketingTriggerKey.COMMENTSOLD_BROWSE_ABANDONED,
    schemaType: SchemaType.MARKETING_COMMENTSOLD_BROWSE_ABANDONMENT,
  },
  [MarketingTriggerKey.CHECKOUT_ABANDONED]: {
    key: MarketingTriggerKey.COMMENTSOLD_CHECKOUT_ABANDONED,
    schemaType: SchemaType.MARKETING_COMMENTSOLD_CHECKOUT_ABANDONMENT,
  },
  // All other triggers: no CommentSold variant — leave the standard mapping.
} as any;

const ABANDONMENT_SKIP_FIELD: Record<
  MarketingTriggerKey,
  TriggerResolution["autoSkipAbandonmentField"]
> = {
  [MarketingTriggerKey.CART_ABANDONED]: "isCartAbandoned",
  [MarketingTriggerKey.CHECKOUT_ABANDONED]: "isCheckoutAbandoned",
  [MarketingTriggerKey.BROWSE_ABANDONED]: "isBrowseAbandoned",
  [MarketingTriggerKey.COMMENTSOLD_CART_ABANDONED]: "isCartAbandoned",
  [MarketingTriggerKey.COMMENTSOLD_CHECKOUT_ABANDONED]: "isCheckoutAbandoned",
  [MarketingTriggerKey.COMMENTSOLD_BROWSE_ABANDONED]: "isBrowseAbandoned",
} as any;

// Klaviyo's trigger filter is an object tree of condition_groups → conditions.
// Returns true if ANY condition has the shape:
//   { type: "metric-property", field: "Source Name",
//     filter: { type: "string", operator: "equals", value: "CommentSold" } }
function hasCommentSoldSourceFilter(triggerFilter: unknown): boolean {
  if (!triggerFilter || typeof triggerFilter !== "object") return false;
  const tf = triggerFilter as any;
  const groups = tf.condition_groups ?? [];
  for (const g of groups) {
    for (const c of g.conditions ?? []) {
      if (
        c.type === "metric-property" &&
        c.field === "Source Name" &&
        c.filter?.type === "string" &&
        c.filter?.operator === "equals" &&
        c.filter?.value === "CommentSold"
      ) {
        return true;
      }
    }
  }
  return false;
}

// Render a Klaviyo trigger_filter into a short human string for a review
// warning, e.g. `survey_code equals 689d034ddda30`. Conditions within a group
// join with AND; groups join with OR. Returns null if nothing readable is
// found (caller falls back to a generic message). mime doesn't yet translate
// trigger_filters to Redo trigger-data expressions — naming the exact filter
// lets the operator re-create it by hand.
export function summarizeTriggerFilter(triggerFilter: unknown): string | null {
  if (!triggerFilter || typeof triggerFilter !== "object") return null;
  const tf = triggerFilter as any;
  const groupStrs: string[] = [];
  for (const g of tf.condition_groups ?? []) {
    const condStrs: string[] = [];
    for (const c of g?.conditions ?? []) {
      const field = c?.field ?? c?.type;
      const op = c?.filter?.operator ?? c?.operator;
      const val = c?.filter?.value ?? c?.value;
      if (!field && !op) continue;
      condStrs.push(
        [field, op, val].filter((x) => x !== undefined && x !== null && x !== "").join(" "),
      );
    }
    if (condStrs.length) groupStrs.push(condStrs.join(" AND "));
  }
  return groupStrs.length ? groupStrs.join(" OR ") : null;
}

function resolveMetricTrigger(
  t: KlaviyoTrigger,
  metrics: MetricLookup,
  flowName: string,
  warnings: ParseWarning[],
): TriggerResolution | null {
  if (!t.id) {
    warnings.push({ kind: "unsupported-trigger", message: `metric trigger has no id` });
    return null;
  }
  const m = metrics[t.id];
  if (!m) {
    warnings.push({
      kind: "unsupported-trigger",
      message: `metric id ${t.id} not found in merchant metrics catalog — run extract-metrics.ts first`,
    });
    return null;
  }
  const hit = METRIC_NAME_MAP[m.name.toLowerCase()];
  if (!hit) {
    warnings.push({
      kind: "unsupported-trigger",
      message: `metric "${m.name}" (${m.integration_name ?? "no integration"}) has no Redo trigger equivalent — flow "${flowName}" skipped`,
    });
    return null;
  }
  // Tag the source so parseFlow can emit the mutually-exclusive viewed-product
  // skip condition for Browse Abandonment flows. Both "Viewed Product" and
  // "Active on Site" map to MARKETING_BROWSE_ABANDONMENT in Redo.
  const lowerName = m.name.toLowerCase();
  const klaviyoSource: TriggerResolution["klaviyoSource"] =
    lowerName === "viewed product"
      ? "viewed-product"
      : lowerName === "active on site"
        ? "active-on-site"
        : undefined;
  // CommentSold detection — upgrade to CS variant if the trigger filter matches.
  // CS variants only exist for the marketing abandonment triggers.
  if (
    hasCommentSoldSourceFilter(t.trigger_filter) &&
    hit.category === "Marketing" &&
    COMMENTSOLD_VARIANTS[hit.key as MarketingTriggerKey]
  ) {
    const cs = COMMENTSOLD_VARIANTS[hit.key as MarketingTriggerKey]!;
    return {
      key: cs.key,
      schemaType: cs.schemaType,
      category: "Marketing",
      autoSkipAbandonmentField: ABANDONMENT_SKIP_FIELD[cs.key],
      klaviyoSource,
    };
  }
  return {
    key: hit.key,
    schemaType: hit.schemaType,
    category: hit.category,
    autoSkipAbandonmentField:
      hit.category === "Marketing"
        ? ABANDONMENT_SKIP_FIELD[hit.key as MarketingTriggerKey]
        : undefined,
    klaviyoSource,
  };
}

function resolveListTrigger(flow: KlaviyoFlow): TriggerResolution {
  // V1 heuristic: SMS-intent flows contain "SMS" in the name. Otherwise email.
  // Default to the generic EMAIL_SIGNUP key ("Marketing email signup") rather
  // than EMAIL_SIGNUP_SHOPIFY — Klaviyo list signups come from many sources
  // (forms, popups, widgets), not just Shopify's native checkbox. Merchant
  // can switch the source-specific variant in Redo if they want.
  // A more robust resolver would call Klaviyo's /lists/{id} to read list_type;
  // captured as a TODO in the V2 plan.
  const name = flow.data.attributes.name.toLowerCase();
  const isSms = /\bsms\b/i.test(name);
  return isSms
    ? { key: MarketingTriggerKey.SMS_SIGNUP, schemaType: SchemaType.SMS_MARKETING_SIGNUP, category: "Marketing" }
    : { key: MarketingTriggerKey.EMAIL_SIGNUP, schemaType: SchemaType.EMAIL_MARKETING_SIGNUP, category: "Marketing" };
}

export function resolveTrigger(
  flow: KlaviyoFlow,
  metrics: MetricLookup,
  warnings: ParseWarning[],
): TriggerResolution | null {
  const defn = flow.data.attributes.definition;
  const triggers = defn?.triggers ?? [];
  if (triggers.length === 0) {
    warnings.push({
      kind: "skipped-flow",
      message: `flow "${flow.data.attributes.name}" has no triggers configured (Unconfigured status)`,
    });
    return null;
  }
  const t = triggers[0];
  switch (t.type) {
    case "metric":
      return resolveMetricTrigger(t, metrics, flow.data.attributes.name, warnings);
    case "list":
      return resolveListTrigger(flow);
    case "segment":
      return {
        key: MarketingTriggerKey.CUSTOMER_GROUP_ENTERED,
        schemaType: SchemaType.MARKETING_SEGMENT_MEMBERSHIP_CHANGE,
        category: "Marketing",
      };
    case "date":
      return { key: MarketingTriggerKey.DATE, schemaType: SchemaType.MARKETING_DATE, category: "Marketing" };
    case "price-drop":
      return { key: MarketingTriggerKey.PRICE_DROP, schemaType: SchemaType.MARKETING_PRICE_DROP, category: "Marketing" };
    default:
      warnings.push({
        kind: "unsupported-trigger",
        message: `trigger type "${t.type}" is not supported`,
      });
      return null;
  }
}

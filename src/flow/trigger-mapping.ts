import type { MetricLookup } from "../extract-metrics.js";
import {
  MarketingTriggerKey,
  OrderTrackingTriggerKey,
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
  "submitted review":      { key: SchemaType.YOTPO_REVIEW_CREATED, schemaType: SchemaType.YOTPO_REVIEW_CREATED, category: "Integration" },
  "yotpo review created":  { key: SchemaType.YOTPO_REVIEW_CREATED, schemaType: SchemaType.YOTPO_REVIEW_CREATED, category: "Integration" },
  "yotpo: submitted review": { key: SchemaType.YOTPO_REVIEW_CREATED, schemaType: SchemaType.YOTPO_REVIEW_CREATED, category: "Integration" },
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

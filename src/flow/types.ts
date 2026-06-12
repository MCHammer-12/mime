// Mirrors of Redo types we emit. Kept intentionally narrow — only the variants
// the migrator produces. Source of truth lives in redoapp:
// redo/model/src/advanced-flow/{advanced-flow-db-parser,steps,triggers,schemas/schemas}.ts

export enum StepType {
  TRIGGER = "trigger",
  CONDITION = "condition",
  WAIT = "wait",
  SEND_EMAIL = "send_email",
  SEND_SMS = "send_sms",
  SEND_WEBHOOK = "send_webhook",
  DO_NOTHING = "do_nothing",
  AB_TEST = "ab_test",
  MANAGE_CUSTOMER_TAGS = "manage_customer_tags",
  MANAGE_STATIC_SEGMENT = "manage_static_segment",
}

export enum SchemaType {
  MARKETING_CART_ABANDONMENT = "marketing_cart_abandonment",
  MARKETING_BROWSE_ABANDONMENT = "marketing_browse_abandonment",
  MARKETING_CHECKOUT_ABANDONMENT = "marketing_checkout_abandonment",
  MARKETING_COMMENTSOLD_CART_ABANDONMENT = "marketing_commentsold_cart_abandonment",
  MARKETING_COMMENTSOLD_BROWSE_ABANDONMENT = "marketing_commentsold_browse_abandonment",
  MARKETING_COMMENTSOLD_CHECKOUT_ABANDONMENT = "marketing_commentsold_checkout_abandonment",
  EMAIL_MARKETING_SIGNUP = "email_marketing_signup",
  SMS_MARKETING_SIGNUP = "sms_marketing_signup",
  MARKETING_SEGMENT_MEMBERSHIP_CHANGE = "marketing_segment_membership_change",
  MARKETING_DATE = "marketing_date",
  MARKETING_PRICE_DROP = "marketing_price_drop",
  MARKETING_BACK_IN_STOCK = "marketing_back_in_stock",
  MARKETING_LOW_INVENTORY = "marketing_low_inventory",
  MARKETING_WARRANTY_REGISTRATION = "marketing_warranty_registration",
  MARKETING_CAMPAIGN = "marketing_campaign",
  REFUND_RETURN_SUBMITTED = "refund_return_submitted",
  EXCHANGE_PROCESSED_WITH_CREDIT = "exchange_processed_with_credit",
  ORDER_TRACKING = "order_tracking",
  REVIEWS = "reviews",
  // Yotpo Integration triggers — `key` and `schemaType` strings happen to be
  // identical for every Yotpo trigger; defined once here and reused as both.
  // Source: redo/model/src/advanced-flow/integration-triggers.ts.
  YOTPO_LOYALTY_EXPIRATION_REMINDER = "yotpo_loyalty_expiration_reminder",
  YOTPO_LOYALTY_POINTS_REMINDER = "yotpo_loyalty_points_reminder",
  YOTPO_LOYALTY_REDEMPTION_REMINDER = "yotpo_loyalty_redemption_reminder",
  YOTPO_LOYALTY_REDEMPTION_CREATED = "yotpo_loyalty_redemption_created",
  YOTPO_LOYALTY_REFERRAL_COMPLETED = "yotpo_loyalty_referral_completed",
  YOTPO_LOYALTY_REFERRAL_SHARED = "yotpo_loyalty_referral_shared",
  YOTPO_LOYALTY_CUSTOMER_BIRTHDAY = "yotpo_loyalty_customer_birthday",
  YOTPO_LOYALTY_OPT_IN = "yotpo_loyalty_opt_in",
  YOTPO_LOYALTY_TIER_EARNED = "yotpo_loyalty_tier_earned",
  YOTPO_LOYALTY_TIER_LOST = "yotpo_loyalty_tier_lost",
  YOTPO_LOYALTY_POINTS_EARNED = "yotpo_loyalty_points_earned",
  YOTPO_REVIEW_CREATED = "yotpo_review_created",
}

// Mirrors redo/model/src/advanced-flow/triggers.ts OrderTrackingTriggerKey.
// All variants share schemaType: SchemaType.ORDER_TRACKING — only the `key`
// changes per trigger.
export enum OrderTrackingTriggerKey {
  ORDER_CREATED = "order_created",
  ORDER_FULFILLED = "order_fulfilled",
  ORDER_PRE_TRANSIT = "order_pre_transit",
  ORDER_IN_TRANSIT = "order_in_transit",
  ORDER_OUT_FOR_DELIVERY = "order_out_for_delivery",
  ORDER_DELIVERED = "order_delivered",
  ORDER_AVAILABLE_FOR_PICKUP = "order_available_for_pickup",
  ORDER_AVAILABLE_FOR_PICKUP_CARRIER = "order_available_for_pickup_carrier",
  ORDER_STALLED_IN_TRANSIT = "order_stalled_in_transit",
  ORDER_STALLED_IN_FULFILLMENT = "order_stalled_in_fulfillment",
  ORDER_DELAYED = "order_delayed",
  ORDER_ARRIVING_EARLY = "order_arriving_early",
  ORDER_RETURN_TO_SENDER = "order_return_to_sender",
  ORDER_DELIVERY_ATTEMPTED = "order_delivery_attempted",
  ORDER_DELIVERY_FAILURE = "order_delivery_failure",
  ORDER_SHIPMENT_CANCELLED = "order_shipment_cancelled",
  ORDER_SHIPMENT_ERROR = "order_shipment_error",
}

// Mirrors redo/model/src/advanced-flow/triggers.ts ReviewsTriggerKey. Generic
// review trigger (category "Reviews") — distinct from the Yotpo-specific
// YOTPO_REVIEW_CREATED on the Integration category.
export enum ReviewsTriggerKey {
  REVIEW_SUBMITTED = "review_submitted",
}

/**
 * Integration triggers — Yotpo Loyalty + Yotpo Reviews. Each Klaviyo flow
 * triggered by a Yotpo metric (when the merchant has Yotpo's Klaviyo
 * integration enabled) maps to one of these via `METRIC_NAME_MAP`. Per
 * `redo/model/src/advanced-flow/advanced-flow-db-parser.ts:618-625` the
 * trigger step has no `eventName` / `triggerSpecificFields` requirements —
 * just the standard base trigger fields plus `category: "Integration"`.
 *
 * The `key` and `schemaType` enum values share the same string per trigger,
 * so the same enum doubles as both. Defined inline on `SchemaType` above
 * for that reason; this type alias is just for readability at call sites
 * that emit Integration triggers specifically.
 */
export type IntegrationTriggerKey =
  | SchemaType.YOTPO_LOYALTY_EXPIRATION_REMINDER
  | SchemaType.YOTPO_LOYALTY_POINTS_REMINDER
  | SchemaType.YOTPO_LOYALTY_REDEMPTION_REMINDER
  | SchemaType.YOTPO_LOYALTY_REDEMPTION_CREATED
  | SchemaType.YOTPO_LOYALTY_REFERRAL_COMPLETED
  | SchemaType.YOTPO_LOYALTY_REFERRAL_SHARED
  | SchemaType.YOTPO_LOYALTY_CUSTOMER_BIRTHDAY
  | SchemaType.YOTPO_LOYALTY_OPT_IN
  | SchemaType.YOTPO_LOYALTY_TIER_EARNED
  | SchemaType.YOTPO_LOYALTY_TIER_LOST
  | SchemaType.YOTPO_LOYALTY_POINTS_EARNED
  | SchemaType.YOTPO_REVIEW_CREATED;

export type FlowCategory =
  | "Marketing"
  | "Order tracking"
  | "Integration"
  | "Reviews";

export type TriggerKey =
  | MarketingTriggerKey
  | OrderTrackingTriggerKey
  | IntegrationTriggerKey
  | ReviewsTriggerKey;

export enum MarketingTriggerKey {
  EMAIL_SIGNUP = "email_signup",
  EMAIL_SIGNUP_SHOPIFY = "email_signup_shopify",
  SMS_SIGNUP = "sms_confirmed",
  MARKETING_CAMPAIGN = "marketing_campaign",
  CART_ABANDONED = "cart_abandoned",
  BROWSE_ABANDONED = "browse_abandoned",
  CHECKOUT_ABANDONED = "checkout_abandoned",
  COMMENTSOLD_CART_ABANDONED = "COMMENTSOLD_CART_ABANDONED",
  COMMENTSOLD_BROWSE_ABANDONED = "COMMENTSOLD_BROWSE_ABANDONED",
  COMMENTSOLD_CHECKOUT_ABANDONED = "COMMENTSOLD_CHECKOUT_ABANDONED",
  BACK_IN_STOCK = "back_in_stock",
  CUSTOMER_GROUP_ENTERED = "customer_group_entered",
  CUSTOMER_GROUP_EXITED = "customer_group_exited",
  WARRANTY_REGISTRATION = "warranty_registration",
  LOW_INVENTORY = "low_inventory",
  DATE = "date",
  PRICE_DROP = "price_drop",
  REFUND_RETURN_SUBMITTED = "refund_return_submitted",
  EXCHANGE_PROCESSED_WITH_CREDIT = "exchange_processed_with_credit",
}

export enum WaitTimeUnit {
  DAYS = "Days",
  HOURS = "Hours",
  MINUTES = "Minutes",
}

export interface BaseStep {
  id: string;
  customTitle?: string;
}

export interface TriggerStep extends BaseStep {
  type: StepType.TRIGGER;
  schemaType: SchemaType;
  category: FlowCategory;
  key: TriggerKey;
  nextId: string;
  skipConditions?: {
    conjunctionMode: "OR";
    conditions: unknown[];
  };
  shouldSkipSmartSending?: boolean;
}

export interface WaitStep extends BaseStep {
  type: StepType.WAIT;
  numDays: number;
  numSeconds?: number;
  timeUnit: WaitTimeUnit;
  nextId: string;
}

export interface SendEmailStep extends BaseStep {
  type: StepType.SEND_EMAIL;
  templateId: string;
  emailAddressFieldName: string;
  recipientNameFieldName: string;
  nextId?: string;
  disabled?: boolean;
}

export interface SendSmsStep extends BaseStep {
  type: StepType.SEND_SMS;
  /** ObjectId of the SmsTemplate created via createSmsTemplate RPC, or a
   *  `__PLACEHOLDER_X__` sentinel to be swapped at import time (mirrors
   *  the email-step pattern). */
  templateId: string;
  /** Schema-instance field name carrying the recipient's phone, in
   *  camelCase. Canonical for Marketing schemas: `customerPhone`. */
  phoneNumberFieldName: string;
  /** Schema-instance field name for the recipient's first name, used by
   *  Liquid in the SMS body. Canonical: `customerFirstName`. */
  recipientNameFieldName: string;
  nextId?: string;
  disabled?: boolean;
  /** Marker tying this SMS step to its A/B variant when multi-variant
   *  send-sms eventually lands. Optional in v1. */
  splitId?: string;
}

export interface SendWebhookStep extends BaseStep {
  type: StepType.SEND_WEBHOOK;
  destinationUrl: string;
  headers: Array<{ key: string; value: string }>;
  payload: string;
  nextId?: string | null;
  disabled: boolean;
  authType?: string | null;
}

export interface DoNothingStep extends BaseStep {
  type: StepType.DO_NOTHING;
  nextId?: string;
}

export interface ConditionStep extends BaseStep {
  type: StepType.CONDITION;
  expression: unknown;
  nextTrueId: string;
  nextFalseId: string;
}

export interface AbTestStep extends BaseStep {
  type: StepType.AB_TEST;
  name?: string;
  description?: string;
  variants: Array<{
    id: string;
    name: string;
    weight: number;
    nextId: string;
  }>;
}

// Redo "add/remove from static segment" step (advanced-flow-db-parser.ts
// manageStaticSegmentStepSchema). Maps Klaviyo's `list-update` action.
// `segmentId` references a real Redo segment that must EXIST — the parser
// can't call Redo, so it emits `_klaviyoListId` as a resolution marker and
// the import path (resolveSegmentSteps in import-rpc.ts) swaps it for a
// real id (match-by-name or create) and strips the marker before send.
export interface ManageStaticSegmentStep extends BaseStep {
  type: StepType.MANAGE_STATIC_SEGMENT;
  operation: "add" | "remove";
  segmentId: string;
  nextId: string;
  disabled: boolean;
  /** Pre-resolution marker — the Klaviyo list id this segment mirrors.
   *  Present only between parse and import; stripped before createAdvancedFlow. */
  _klaviyoListId?: string;
}

export type Step =
  | TriggerStep
  | WaitStep
  | SendEmailStep
  | SendSmsStep
  | SendWebhookStep
  | ManageStaticSegmentStep
  | DoNothingStep
  | ConditionStep
  | AbTestStep;

export interface AdvancedFlow {
  team: string;
  name: string;
  description?: string;
  enabled: boolean;
  steps: Step[];
  schemaType: SchemaType;
  category: FlowCategory;
  createdByUserId?: string;
  versionGroupId: string;
}

// Minimal shape of a Klaviyo flow JSON as returned by the extractor.
export interface KlaviyoFlow {
  data: {
    id: string;
    attributes: {
      name: string;
      status: "live" | "draft" | "manual" | "disabled" | string;
      trigger_type: string;
      created?: string | null;
      updated?: string | null;
      definition: {
        triggers: KlaviyoTrigger[];
        profile_filter: unknown;
        actions: KlaviyoAction[];
      } | null;
    };
  };
}

export interface KlaviyoTrigger {
  type: "metric" | "list" | "segment" | "date" | "price-drop" | string;
  id?: string;
  trigger_filter?: unknown;
  price_drop_amount_value?: number;
  price_drop_amount_unit?: "percent" | "dollar" | string;
  audience?: string[];
  timeframe_days?: number;
}

export interface KlaviyoAction {
  id: string;
  type:
    | "send-email"
    | "send-sms"
    | "send-webhook"
    | "time-delay"
    | "conditional-split"
    | "trigger-split"
    | "ab-test"
    | "update-profile"
    | "list-update"
    | "target-date"
    | string;
  data?: any;
  links?: {
    next?: string | null;
    next_if_true?: string | null;
    next_if_false?: string | null;
  };
}

export interface ParseWarning {
  kind:
    | "unsupported-action"
    | "unsupported-trigger"
    | "degraded-mapping"
    | "skipped-flow"
    | "skipped-step"
    | "requires-review";
  message: string;
  actionId?: string;
}

export interface ParseContext {
  warnings: ParseWarning[];
}

export interface ParseResult {
  automation: AdvancedFlow | null;
  warnings: ParseWarning[];
  // Map of placeholder templateId sentinels we emitted → metadata the
  // downstream importer uses to create a real blank template.
  placeholderTemplates: PlaceholderTemplate[];
  // Klaviyo send-sms actions translated to placeholder SMS templates.
  // Importer calls createSmsTemplate for each, then swaps the sentinel
  // on the matching SendSmsStep with the real ObjectId.
  placeholderSmsTemplates: PlaceholderSmsTemplate[];
  skipped?: {
    reason: string;
    /** When true the caller can recover by re-running parseFlow with a
     *  user-chosen trigger via opts.forcedTrigger (e.g. unknown Klaviyo
     *  metric → user picks a Redo trigger). */
    recoverable?: boolean;
    /** Klaviyo trigger object (echoed from the source flow) so the caller
     *  can render context for the user when prompting. */
    klaviyoTrigger?: unknown;
  };
}

export interface PlaceholderTemplate {
  sentinelId: string;
  klaviyoTemplateId: string | null;
  subject: string;
  fromEmail: string | null;
  fromLabel: string | null;
  previewText: string | null;
  /**
   * Full Redo EmailTemplate JSON when the referenced Klaviyo template was
   * successfully resolved + parsed. When null, the importer creates a blank
   * placeholder (subject + metadata only, empty sections). Includes:
   *   - `sections` (parsed from Klaviyo HTML via src/parser/)
   *   - `_pendingFilter` on product blocks (resolved to real IDs at import)
   *   - `_fontPlan` (synced into brand kit at import)
   *   - `schemaType` (auto-detected: marketing_checkout_abandonment if the
   *     template uses {{ event.CheckoutURL }}, else marketing_email)
   */
  fullTemplate: Record<string, any> | null;
  /** Warnings produced by the template parser (separate from flow warnings). */
  templateWarnings: string[];
}

/**
 * Klaviyo `send-sms` action → metadata for createSmsTemplate. The mime parser
 * emits one of these per send-sms (with `sentinelId` matching the bogus
 * templateId on the corresponding SendSmsStep). The importer creates a real
 * SmsTemplate on the team and rewrites the step's templateId to the real
 * ObjectId, then strips this entry from the bundle.
 *
 * `schemaType` and `category` are populated from the parent flow at
 * emission time so the importer can pass them straight through to the RPC
 * (Redo's createSmsTemplate handler validates schemaType matches an
 * existing trigger config and uses it to attach an aiConfig).
 */
export interface PlaceholderSmsTemplate {
  sentinelId: string;
  klaviyoActionId: string;
  /** Display name for the SmsTemplate. Klaviyo `data.message.name`
   *  ("SMS #1") or a body-preview fallback. */
  name: string;
  /** SMS body, after Liquid rewrite (Klaviyo → Redo schema-instance vars). */
  content: string;
  /** From the parent flow's resolved trigger. */
  schemaType: SchemaType;
  category: FlowCategory;
  /** Mirrors Klaviyo's `shorten_links`. Always emitted (true or false) so
   *  the importer can override Redo's mongoose default of `true`. */
  autoShortenLinks?: boolean;
  /** Klaviyo's image_id (MMS) — informational only in v1; the importer
   *  warns and skips the attachment because rehosting + the Redo
   *  attachments[] schema are out of scope for v1. */
  smsImageId?: string;
  /** Per-step warnings (same shape as templateWarnings on the email
   *  placeholder). Includes Liquid rewrite tokens we couldn't map. */
  templateWarnings: string[];
}

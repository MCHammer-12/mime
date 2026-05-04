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
}

export enum OrderTrackingTriggerKey {
  ORDER_CREATED = "order_created",
}

export type FlowCategory = "Marketing" | "Order tracking";

export type TriggerKey = MarketingTriggerKey | OrderTrackingTriggerKey;

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
  body: string;
  nextId?: string;
  disabled?: boolean;
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

export type Step =
  | TriggerStep
  | WaitStep
  | SendEmailStep
  | SendSmsStep
  | SendWebhookStep
  | DoNothingStep
  | ConditionStep;

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

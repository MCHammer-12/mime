/**
 * Curated list of Redo flow triggers a user can pick from when an imported
 * Klaviyo flow has an unresolvable trigger. Mostly Marketing-category, but
 * includes the Order-tracking ORDER_CREATED trigger as the post-purchase
 * landing spot (Redo doesn't expose post-purchase as a Marketing trigger).
 *
 * Mirrors the displayName + (key, schemaType, category) shape the Redo team
 * uses in their flow editor (see redo/model/src/advanced-flow/triggers.ts
 * schemaTypeConfigs).
 *
 * Order is curated for picker UX — most common pick types first.
 */

import { MarketingTriggerKey, OrderTrackingTriggerKey, SchemaType } from "./types.js";
import type { TriggerResolution } from "./trigger-mapping.js";

export interface MarketingTriggerOption {
  /** Stable identifier — sent to/from the UI as the answer value. */
  value: string;
  /** Human-readable label, mirrors Redo's flow editor. */
  label: string;
  resolution: TriggerResolution;
}

export const MARKETING_TRIGGER_OPTIONS: MarketingTriggerOption[] = [
  {
    value: "cart_abandonment",
    label: "Cart abandonment",
    resolution: {
      key: MarketingTriggerKey.CART_ABANDONED,
      schemaType: SchemaType.MARKETING_CART_ABANDONMENT,
      category: "Marketing",
      autoSkipAbandonmentField: "isCartAbandoned",
    },
  },
  {
    value: "checkout_abandonment",
    label: "Checkout abandonment",
    resolution: {
      key: MarketingTriggerKey.CHECKOUT_ABANDONED,
      schemaType: SchemaType.MARKETING_CHECKOUT_ABANDONMENT,
      category: "Marketing",
      autoSkipAbandonmentField: "isCheckoutAbandoned",
    },
  },
  {
    value: "browse_abandonment",
    label: "Browse abandonment",
    resolution: {
      key: MarketingTriggerKey.BROWSE_ABANDONED,
      schemaType: SchemaType.MARKETING_BROWSE_ABANDONMENT,
      category: "Marketing",
      autoSkipAbandonmentField: "isBrowseAbandoned",
    },
  },
  {
    value: "order_created",
    label: "Order created (post-purchase)",
    resolution: {
      key: OrderTrackingTriggerKey.ORDER_CREATED,
      schemaType: SchemaType.ORDER_TRACKING,
      category: "Order tracking",
    },
  },
  {
    value: "email_signup",
    label: "Email marketing sign-up",
    resolution: {
      key: MarketingTriggerKey.EMAIL_SIGNUP_SHOPIFY,
      schemaType: SchemaType.EMAIL_MARKETING_SIGNUP,
      category: "Marketing",
    },
  },
  {
    value: "sms_signup",
    label: "SMS marketing sign-up",
    resolution: {
      key: MarketingTriggerKey.SMS_SIGNUP,
      schemaType: SchemaType.SMS_MARKETING_SIGNUP,
      category: "Marketing",
    },
  },
  {
    value: "back_in_stock",
    label: "Back in stock",
    resolution: {
      key: MarketingTriggerKey.BACK_IN_STOCK,
      schemaType: SchemaType.MARKETING_BACK_IN_STOCK,
      category: "Marketing",
    },
  },
  {
    value: "low_inventory",
    label: "Low inventory",
    resolution: {
      key: MarketingTriggerKey.LOW_INVENTORY,
      schemaType: SchemaType.MARKETING_LOW_INVENTORY,
      category: "Marketing",
    },
  },
  {
    value: "segment_change",
    label: "Segment membership change",
    resolution: {
      key: MarketingTriggerKey.CUSTOMER_GROUP_ENTERED,
      schemaType: SchemaType.MARKETING_SEGMENT_MEMBERSHIP_CHANGE,
      category: "Marketing",
    },
  },
  {
    value: "warranty_registration",
    label: "Warranty registration",
    resolution: {
      key: MarketingTriggerKey.WARRANTY_REGISTRATION,
      schemaType: SchemaType.MARKETING_WARRANTY_REGISTRATION,
      category: "Marketing",
    },
  },
  {
    value: "date",
    label: "Date (anniversary, birthday, …)",
    resolution: {
      key: MarketingTriggerKey.DATE,
      schemaType: SchemaType.MARKETING_DATE,
      category: "Marketing",
    },
  },
  {
    value: "price_drop",
    label: "Price drop",
    resolution: {
      key: MarketingTriggerKey.PRICE_DROP,
      schemaType: SchemaType.MARKETING_PRICE_DROP,
      category: "Marketing",
    },
  },
  {
    value: "refund_return_submitted",
    label: "Refund return submitted",
    resolution: {
      key: MarketingTriggerKey.REFUND_RETURN_SUBMITTED,
      schemaType: SchemaType.REFUND_RETURN_SUBMITTED,
      category: "Marketing",
    },
  },
  {
    value: "exchange_processed_with_credit",
    label: "Exchange processed with leftover credit",
    resolution: {
      key: MarketingTriggerKey.EXCHANGE_PROCESSED_WITH_CREDIT,
      schemaType: SchemaType.EXCHANGE_PROCESSED_WITH_CREDIT,
      category: "Marketing",
    },
  },
];

export function findOptionByValue(value: string): MarketingTriggerOption | null {
  return MARKETING_TRIGGER_OPTIONS.find((o) => o.value === value) ?? null;
}

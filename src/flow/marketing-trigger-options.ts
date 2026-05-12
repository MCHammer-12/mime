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

import {
  MarketingTriggerKey,
  OrderTrackingTriggerKey,
  ReviewsTriggerKey,
  SchemaType,
} from "./types.js";
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
    label: "Marketing email signup",
    resolution: {
      key: MarketingTriggerKey.EMAIL_SIGNUP,
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

  // ─── Yotpo Integration triggers ──────────────────────────────────
  // Yotpo Loyalty + Yotpo Reviews. Each is its own (key, schemaType)
  // pair — strings happen to match. category is "Integration" not
  // "Marketing" so the imported flow lands in Redo's Integration tab.
  {
    value: "yotpo_loyalty_tier_earned",
    label: "Yotpo loyalty tier earned",
    resolution: {
      key: SchemaType.YOTPO_LOYALTY_TIER_EARNED,
      schemaType: SchemaType.YOTPO_LOYALTY_TIER_EARNED,
      category: "Integration",
    },
  },
  {
    value: "yotpo_loyalty_tier_lost",
    label: "Yotpo loyalty tier lost",
    resolution: {
      key: SchemaType.YOTPO_LOYALTY_TIER_LOST,
      schemaType: SchemaType.YOTPO_LOYALTY_TIER_LOST,
      category: "Integration",
    },
  },
  {
    value: "yotpo_loyalty_points_earned",
    label: "Yotpo loyalty points earned",
    resolution: {
      key: SchemaType.YOTPO_LOYALTY_POINTS_EARNED,
      schemaType: SchemaType.YOTPO_LOYALTY_POINTS_EARNED,
      category: "Integration",
    },
  },
  {
    value: "yotpo_loyalty_expiration_reminder",
    label: "Yotpo loyalty expiration reminder",
    resolution: {
      key: SchemaType.YOTPO_LOYALTY_EXPIRATION_REMINDER,
      schemaType: SchemaType.YOTPO_LOYALTY_EXPIRATION_REMINDER,
      category: "Integration",
    },
  },
  {
    value: "yotpo_loyalty_points_reminder",
    label: "Yotpo loyalty points reminder",
    resolution: {
      key: SchemaType.YOTPO_LOYALTY_POINTS_REMINDER,
      schemaType: SchemaType.YOTPO_LOYALTY_POINTS_REMINDER,
      category: "Integration",
    },
  },
  {
    value: "yotpo_loyalty_redemption_reminder",
    label: "Yotpo loyalty redemption reminder",
    resolution: {
      key: SchemaType.YOTPO_LOYALTY_REDEMPTION_REMINDER,
      schemaType: SchemaType.YOTPO_LOYALTY_REDEMPTION_REMINDER,
      category: "Integration",
    },
  },
  {
    value: "yotpo_loyalty_redemption_created",
    label: "Yotpo loyalty redemption created",
    resolution: {
      key: SchemaType.YOTPO_LOYALTY_REDEMPTION_CREATED,
      schemaType: SchemaType.YOTPO_LOYALTY_REDEMPTION_CREATED,
      category: "Integration",
    },
  },
  {
    value: "yotpo_loyalty_referral_completed",
    label: "Yotpo loyalty referral completed",
    resolution: {
      key: SchemaType.YOTPO_LOYALTY_REFERRAL_COMPLETED,
      schemaType: SchemaType.YOTPO_LOYALTY_REFERRAL_COMPLETED,
      category: "Integration",
    },
  },
  {
    value: "yotpo_loyalty_referral_shared",
    label: "Yotpo loyalty referral shared",
    resolution: {
      key: SchemaType.YOTPO_LOYALTY_REFERRAL_SHARED,
      schemaType: SchemaType.YOTPO_LOYALTY_REFERRAL_SHARED,
      category: "Integration",
    },
  },
  {
    value: "yotpo_loyalty_customer_birthday",
    label: "Yotpo loyalty customer birthday",
    resolution: {
      key: SchemaType.YOTPO_LOYALTY_CUSTOMER_BIRTHDAY,
      schemaType: SchemaType.YOTPO_LOYALTY_CUSTOMER_BIRTHDAY,
      category: "Integration",
    },
  },
  {
    value: "yotpo_loyalty_opt_in",
    label: "Yotpo loyalty opt in",
    resolution: {
      key: SchemaType.YOTPO_LOYALTY_OPT_IN,
      schemaType: SchemaType.YOTPO_LOYALTY_OPT_IN,
      category: "Integration",
    },
  },
  {
    value: "yotpo_review_created",
    label: "Yotpo review created",
    resolution: {
      key: SchemaType.YOTPO_REVIEW_CREATED,
      schemaType: SchemaType.YOTPO_REVIEW_CREATED,
      category: "Integration",
    },
  },

  // ─── Reviews (generic — non-Yotpo platforms) ─────────────────────
  {
    value: "review_submitted",
    label: "Review submitted",
    resolution: {
      key: ReviewsTriggerKey.REVIEW_SUBMITTED,
      schemaType: SchemaType.REVIEWS,
      category: "Reviews",
    },
  },

  // ─── Order tracking — full set ───────────────────────────────────
  // ORDER_CREATED is already listed above as a top-level picker option
  // (post-purchase). The rest land here for completeness, ordered
  // roughly by the customer-journey timeline.
  {
    value: "order_fulfilled",
    label: "Order fulfilled",
    resolution: {
      key: OrderTrackingTriggerKey.ORDER_FULFILLED,
      schemaType: SchemaType.ORDER_TRACKING,
      category: "Order tracking",
    },
  },
  {
    value: "order_pre_transit",
    label: "Order pre-transit",
    resolution: {
      key: OrderTrackingTriggerKey.ORDER_PRE_TRANSIT,
      schemaType: SchemaType.ORDER_TRACKING,
      category: "Order tracking",
    },
  },
  {
    value: "order_in_transit",
    label: "Order in-transit",
    resolution: {
      key: OrderTrackingTriggerKey.ORDER_IN_TRANSIT,
      schemaType: SchemaType.ORDER_TRACKING,
      category: "Order tracking",
    },
  },
  {
    value: "order_out_for_delivery",
    label: "Order out for delivery",
    resolution: {
      key: OrderTrackingTriggerKey.ORDER_OUT_FOR_DELIVERY,
      schemaType: SchemaType.ORDER_TRACKING,
      category: "Order tracking",
    },
  },
  {
    value: "order_delivered",
    label: "Order delivered",
    resolution: {
      key: OrderTrackingTriggerKey.ORDER_DELIVERED,
      schemaType: SchemaType.ORDER_TRACKING,
      category: "Order tracking",
    },
  },
  {
    value: "order_available_for_pickup",
    label: "Order available for pickup",
    resolution: {
      key: OrderTrackingTriggerKey.ORDER_AVAILABLE_FOR_PICKUP,
      schemaType: SchemaType.ORDER_TRACKING,
      category: "Order tracking",
    },
  },
  {
    value: "order_available_for_pickup_carrier",
    label: "Order available for pickup (carrier)",
    resolution: {
      key: OrderTrackingTriggerKey.ORDER_AVAILABLE_FOR_PICKUP_CARRIER,
      schemaType: SchemaType.ORDER_TRACKING,
      category: "Order tracking",
    },
  },
  {
    value: "order_stalled_in_transit",
    label: "Order stalled in transit",
    resolution: {
      key: OrderTrackingTriggerKey.ORDER_STALLED_IN_TRANSIT,
      schemaType: SchemaType.ORDER_TRACKING,
      category: "Order tracking",
    },
  },
  {
    value: "order_stalled_in_fulfillment",
    label: "Order stalled in fulfillment",
    resolution: {
      key: OrderTrackingTriggerKey.ORDER_STALLED_IN_FULFILLMENT,
      schemaType: SchemaType.ORDER_TRACKING,
      category: "Order tracking",
    },
  },
  {
    value: "order_delayed",
    label: "Order delayed",
    resolution: {
      key: OrderTrackingTriggerKey.ORDER_DELAYED,
      schemaType: SchemaType.ORDER_TRACKING,
      category: "Order tracking",
    },
  },
  {
    value: "order_arriving_early",
    label: "Order arriving early",
    resolution: {
      key: OrderTrackingTriggerKey.ORDER_ARRIVING_EARLY,
      schemaType: SchemaType.ORDER_TRACKING,
      category: "Order tracking",
    },
  },
  {
    value: "order_return_to_sender",
    label: "Order return to sender",
    resolution: {
      key: OrderTrackingTriggerKey.ORDER_RETURN_TO_SENDER,
      schemaType: SchemaType.ORDER_TRACKING,
      category: "Order tracking",
    },
  },
  {
    value: "order_delivery_attempted",
    label: "Order delivery attempted",
    resolution: {
      key: OrderTrackingTriggerKey.ORDER_DELIVERY_ATTEMPTED,
      schemaType: SchemaType.ORDER_TRACKING,
      category: "Order tracking",
    },
  },
  {
    value: "order_delivery_failure",
    label: "Order delivery failure",
    resolution: {
      key: OrderTrackingTriggerKey.ORDER_DELIVERY_FAILURE,
      schemaType: SchemaType.ORDER_TRACKING,
      category: "Order tracking",
    },
  },
  {
    value: "order_shipment_cancelled",
    label: "Order shipment cancelled",
    resolution: {
      key: OrderTrackingTriggerKey.ORDER_SHIPMENT_CANCELLED,
      schemaType: SchemaType.ORDER_TRACKING,
      category: "Order tracking",
    },
  },
  {
    value: "order_shipment_error",
    label: "Order shipment error",
    resolution: {
      key: OrderTrackingTriggerKey.ORDER_SHIPMENT_ERROR,
      schemaType: SchemaType.ORDER_TRACKING,
      category: "Order tracking",
    },
  },
];

export function findOptionByValue(value: string): MarketingTriggerOption | null {
  return MARKETING_TRIGGER_OPTIONS.find((o) => o.value === value) ?? null;
}

/**
 * Infer a Shopify discount configuration from the email copy surrounding a
 * Klaviyo {% coupon_code %} tag, so the importer can create the discount and
 * wire the chip's `discountId` (a chip without one renders as nothing).
 *
 * Only offers the copy states outright are used — an email that never names
 * the value gets `null`, and the importer warns instead of inventing a
 * discount the merchant didn't offer.
 */
import type { InferredDiscountConfig } from "./renderer/types.js";

// Mirrors what the Redo dashboard writes for a plain code discount (verified
// against live getDiscounts output): single-use per customer, money discounts
// stack with shipping only.
const MONEY_BASE = {
  combinesWith: {
    orderDiscounts: false,
    productDiscounts: false,
    shippingDiscount: true,
  },
  excludeItemsOnSale: false,
  customerEligibility: "all",
  appliesOncePerCustomer: true,
};

export function extractCouponName(text: string): string | null {
  const m = text.match(/\{%\s*coupon_code\s*'([^']*)'?\s*%\}/);
  return m?.[1] || null;
}

export function inferDiscountConfig(
  copy: string,
): InferredDiscountConfig | null {
  const text = copy.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  const expiration = inferExpiration(text);
  const expiresNote =
    "days" in expiration ? `, expires in ${expiration.days} days` : "";

  const pct = text.match(/(\d+)\s*%\s*(?:off|discount)/i);
  if (pct) {
    return {
      discountSettings: {
        settingsType: "SHOPIFY_BASIC",
        discountValueType: "percentage",
        discountValueAmount: Number(pct[1]),
        ...MONEY_BASE,
        ...minimumRequirement(text),
      },
      expiration,
      summary: `${pct[1]}% off${minSummary(text)}${expiresNote}`,
    };
  }

  const amt = text.match(/\$\s*(\d+(?:\.\d+)?)\s*off/i);
  if (amt) {
    return {
      discountSettings: {
        settingsType: "SHOPIFY_BASIC",
        discountValueType: "amount",
        discountValueAmount: Number(amt[1]),
        ...MONEY_BASE,
        ...minimumRequirement(text),
      },
      expiration,
      summary: `$${amt[1]} off${minSummary(text)}${expiresNote}`,
    };
  }

  if (/free\s+(?:standard\s+)?shipping/i.test(text)) {
    return {
      discountSettings: {
        settingsType: "SHOPIFY_FREE_SHIPPING",
        combinesWith: {
          orderDiscounts: false,
          productDiscounts: false,
          shippingDiscount: false,
        },
      },
      expiration,
      summary: `free shipping${expiresNote}`,
    };
  }

  return null;
}

function inferExpiration(
  text: string,
): InferredDiscountConfig["expiration"] {
  const m =
    text.match(/expires?\s+in\s+(\d+)\s+days?/i) ??
    text.match(/valid\s+for\s+(?:the\s+next\s+)?(\d+)\s+days?/i) ??
    text.match(/(?:for|within)\s+the\s+next\s+(\d+)\s+days?/i);
  return m
    ? { expirationType: "expiration", days: Number(m[1]) }
    : { expirationType: "never" };
}

function findMinimum(text: string): number | null {
  const m =
    text.match(/(?:orders?|purchases?)\s+(?:of\s+)?(?:over|above)\s+\$\s*(\d+)/i) ??
    text.match(/over\s+\$\s*(\d+)/i) ??
    text.match(/\$\s*(\d+)\s*(?:\+|or\s+more)/i);
  return m ? Number(m[1]) : null;
}

function minimumRequirement(text: string) {
  const min = findMinimum(text);
  return min
    ? { minimumRequirement: { type: "minimumSubtotal", minimum: min } }
    : {};
}

function minSummary(text: string): string {
  const min = findMinimum(text);
  return min ? ` on orders over $${min}` : "";
}

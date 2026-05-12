/**
 * Smoke test for trigger-mapping.ts METRIC_NAME_MAP. Walks a representative
 * subset of Klaviyo metric names and asserts they resolve to the expected
 * Redo (key, schemaType, category) tuple. Locks in the 2026-05-08 expansion
 * to the full OrderTrackingTriggerKey set + generic Reviews triggers.
 *
 *   npx tsx src/flow/trigger-mapping.smoke.ts
 */
import { resolveTrigger } from "./trigger-mapping.js";
import {
  OrderTrackingTriggerKey,
  ReviewsTriggerKey,
  SchemaType,
  type KlaviyoFlow,
  type KlaviyoTrigger,
  type ParseWarning,
} from "./types.js";
import type { MetricLookup } from "../extract-metrics.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function flowFor(metricId: string): KlaviyoFlow {
  return {
    data: {
      id: "flow-x",
      attributes: {
        name: "Smoke flow",
        status: "live",
        definition: {
          triggers: [{ type: "metric", id: metricId } as KlaviyoTrigger],
          actions: [],
        },
      },
    },
  } as any;
}

interface Case {
  metricName: string;
  expectKey: string;
  expectSchema: string;
  expectCategory: string;
}

const CASES: Case[] = [
  // Order tracking
  { metricName: "Fulfilled Order",          expectKey: OrderTrackingTriggerKey.ORDER_FULFILLED,         expectSchema: SchemaType.ORDER_TRACKING, expectCategory: "Order tracking" },
  { metricName: "order shipped",            expectKey: OrderTrackingTriggerKey.ORDER_FULFILLED,         expectSchema: SchemaType.ORDER_TRACKING, expectCategory: "Order tracking" },
  { metricName: "Shipment Pre-Transit",     expectKey: OrderTrackingTriggerKey.ORDER_PRE_TRANSIT,       expectSchema: SchemaType.ORDER_TRACKING, expectCategory: "Order tracking" },
  { metricName: "Shipment In Transit",      expectKey: OrderTrackingTriggerKey.ORDER_IN_TRANSIT,        expectSchema: SchemaType.ORDER_TRACKING, expectCategory: "Order tracking" },
  { metricName: "Shipment Out for Delivery", expectKey: OrderTrackingTriggerKey.ORDER_OUT_FOR_DELIVERY, expectSchema: SchemaType.ORDER_TRACKING, expectCategory: "Order tracking" },
  { metricName: "Shipment Delivered",       expectKey: OrderTrackingTriggerKey.ORDER_DELIVERED,         expectSchema: SchemaType.ORDER_TRACKING, expectCategory: "Order tracking" },
  { metricName: "Order Delivered",          expectKey: OrderTrackingTriggerKey.ORDER_DELIVERED,         expectSchema: SchemaType.ORDER_TRACKING, expectCategory: "Order tracking" },
  { metricName: "Available for Pickup",     expectKey: OrderTrackingTriggerKey.ORDER_AVAILABLE_FOR_PICKUP, expectSchema: SchemaType.ORDER_TRACKING, expectCategory: "Order tracking" },
  { metricName: "Stalled in Transit",       expectKey: OrderTrackingTriggerKey.ORDER_STALLED_IN_TRANSIT, expectSchema: SchemaType.ORDER_TRACKING, expectCategory: "Order tracking" },
  { metricName: "Shipment Delayed",         expectKey: OrderTrackingTriggerKey.ORDER_DELAYED,           expectSchema: SchemaType.ORDER_TRACKING, expectCategory: "Order tracking" },
  { metricName: "Return to Sender",         expectKey: OrderTrackingTriggerKey.ORDER_RETURN_TO_SENDER,  expectSchema: SchemaType.ORDER_TRACKING, expectCategory: "Order tracking" },
  { metricName: "Delivery Failure",         expectKey: OrderTrackingTriggerKey.ORDER_DELIVERY_FAILURE,  expectSchema: SchemaType.ORDER_TRACKING, expectCategory: "Order tracking" },
  { metricName: "Shipment Cancelled",       expectKey: OrderTrackingTriggerKey.ORDER_SHIPMENT_CANCELLED, expectSchema: SchemaType.ORDER_TRACKING, expectCategory: "Order tracking" },
  { metricName: "Shipment Error",           expectKey: OrderTrackingTriggerKey.ORDER_SHIPMENT_ERROR,    expectSchema: SchemaType.ORDER_TRACKING, expectCategory: "Order tracking" },
  // Reviews (generic) — non-Yotpo
  { metricName: "Review Submitted",         expectKey: ReviewsTriggerKey.REVIEW_SUBMITTED, expectSchema: SchemaType.REVIEWS, expectCategory: "Reviews" },
  { metricName: "Submitted Review",         expectKey: ReviewsTriggerKey.REVIEW_SUBMITTED, expectSchema: SchemaType.REVIEWS, expectCategory: "Reviews" },
  { metricName: "Judge.me Review Created",  expectKey: ReviewsTriggerKey.REVIEW_SUBMITTED, expectSchema: SchemaType.REVIEWS, expectCategory: "Reviews" },
  { metricName: "Loox Review Submitted",    expectKey: ReviewsTriggerKey.REVIEW_SUBMITTED, expectSchema: SchemaType.REVIEWS, expectCategory: "Reviews" },
  { metricName: "Stamped Review Created",   expectKey: ReviewsTriggerKey.REVIEW_SUBMITTED, expectSchema: SchemaType.REVIEWS, expectCategory: "Reviews" },
  // Yotpo (Integration) — unchanged
  { metricName: "Yotpo Review Created",     expectKey: SchemaType.YOTPO_REVIEW_CREATED, expectSchema: SchemaType.YOTPO_REVIEW_CREATED, expectCategory: "Integration" },
  { metricName: "Yotpo: Submitted Review",  expectKey: SchemaType.YOTPO_REVIEW_CREATED, expectSchema: SchemaType.YOTPO_REVIEW_CREATED, expectCategory: "Integration" },
];

let total = 0;
for (const c of CASES) {
  total++;
  const metrics: MetricLookup = { m1: { id: "m1", name: c.metricName, integration_name: null } as any };
  const warnings: ParseWarning[] = [];
  const out = resolveTrigger(flowFor("m1"), metrics, warnings);
  if (!out) fail(`"${c.metricName}" returned null; warnings=${JSON.stringify(warnings)}`);
  if (out.key !== c.expectKey) fail(`"${c.metricName}": key=${out.key}, expected ${c.expectKey}`);
  if (out.schemaType !== c.expectSchema) fail(`"${c.metricName}": schemaType=${out.schemaType}, expected ${c.expectSchema}`);
  if (out.category !== c.expectCategory) fail(`"${c.metricName}": category=${out.category}, expected ${c.expectCategory}`);
}

console.log(`✓ trigger-mapping smoke: ${total} mappings pass`);

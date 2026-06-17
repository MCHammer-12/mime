# Klaviyo → Redo segment field mapping (authoritative)

**Status:** research complete 2026-06-16. The spec for extending `src/segments/maps.ts` + `substitutions.ts` + `translate.ts`. A few rows are flagged **NEEDS MICHAEL** — see the bottom.
**Sources:** Klaviyo OpenAPI `create_segment.json` + help center; Redo `redo/model/src/marketing/segments/*` (segment-types.ts, segment-data-structures.ts, segment-where-condition.ts, segment-timeframe.ts).

## How to read
- **Tier** — `exact` (clean 1:1), `substituted` (proxy + "here's our logic", needs the ±10% count check), `unsupported` (no Redo target → drop + warn).
- **Proto** — ✅ already handled on `feat/segment-migration`; ➕ needs adding; — n/a.

Klaviyo definition = `condition_groups[]` (AND) → `conditions[]` (OR). Redo = `{conjunction:"AND", conditionBlocks:[{operator:"OR", conditions}]}`. Structural map is 1:1 (✅).

---

## 1. `profile-property` — standard fields

| Klaviyo property | Redo target | Tier | Proto | Notes |
|---|---|---|---|---|
| `email` / `$email` | `email-address` (string) | exact* | ✅ | *Klaviyo `equals`→Redo `contains` (no exact-equals string op); `in`→OR of contains; `regex`→unsupported |
| `phone_number` | `phone-number-area-code` (token) **only** | substituted/unsupported | ➕ | Redo can't match full phone strings — only area code. General phone match → unsupported |
| `first_name` / `last_name` | `customer-name` (string) | substituted | ➕ | Redo has only full `customer-name`; first/last → `contains` (degraded) |
| `title` | — | unsupported | ➕ | no Redo target (→ custom field if defined) |
| `organization` | — | unsupported | ➕ | |
| `image` | — | unsupported | — | not a segmentation field |
| `address1`/`address2` | — | unsupported | ➕ | Redo has no street-address dim |
| `city` / `location['city']` | `city` (token-hierarchy) | **NEEDS MICHAEL** | ➕ | Redo `city` needs country+state prerequisites; Klaviyo city is plain text → see Q3 |
| `region` / `$region` (state) | `state-province` (token-hierarchy) | substituted | ✅ | assumes country US (prereq) |
| `country` / `$country` | `country` (token) | exact | ✅ | name→ISO map (partial in proto — needs full ISO table) |
| `zip` / `$zip` | — (Redo ZIP commented out) | unsupported | ➕ | no Redo zip characteristic |
| `latitude`/`longitude` | — | unsupported | ➕ | (proximity-to-city is city-based, not lat/long) |
| `timezone` | — | unsupported | ➕ | no Redo timezone dim |
| `locale` | — | unsupported | ➕ | |
| `created` (profile created) | `created-time` (date) | exact | ➕ | direct date map |
| `updated` | — | unsupported | ➕ | Redo has only `created-time` |
| `last_active` | — | **NEEDS MICHAEL** | ➕ | no Redo last-activity dim → see Q2 |
| `$source` (initial source) | — | unsupported | ➕ | |
| date custom props / anniversaries | `custom-fields` (date) or `birthday` | substituted | ➕ | birthday→`birthday` (annual); other dates→custom-field if defined |

**Operators (string):** Klaviyo `equals, not-equals, contains, not-contains, starts-with, not-starts-with, ends-with, not-ends-with, in, not-in, regex, nregex` → Redo `contains, not_contains, starts_with, ends_with`. Unmapped: `equals`→`contains`(degrade), `in`→OR, `regex/nregex`→unsupported, `not-starts-with/not-ends-with`→unsupported (Redo lacks negated prefix/suffix).
**Operators (numeric):** Klaviyo `equals, not-equals, greater-than, greater-than-or-equal, less-than, less-than-or-equal, between` → Redo `eq, neq, gt, gte, lt, lte` + `between`→two conditions. (✅ in `maps.ts` minus `between`.)

---

## 2. `profile-predictive-analytics`

| Klaviyo `dimension` | Redo target | Tier | Proto | Logic |
|---|---|---|---|---|
| `historic_clv` / `predicted_clv` / `total_clv` | `order-placed` count ≥ ⌈CLV÷AOV⌉ | substituted | ✅ | AOV-seeded, count auto-tuned to Klaviyo population |
| `average_order_value` | `order-placed` w/ `order_total {op} X` | substituted | ✅ | per-order proxy ("has an order over $X"), not lifetime AOV |
| `historic_number_of_orders` / `predicted_number_of_orders` | `order-placed` count `{op} N` | substituted | ✅ | direct count, no AOV |
| `churn_probability` | `order-placed` zero_times in last N days | substituted | ✅ | N auto-tuned |
| `average_days_between_orders` | — | unsupported | ✅ | no Redo equivalent |
| `expected_date_of_next_purchase` | — | unsupported | ✅ | no Redo equivalent |
| `predicted_gender` | — | unsupported | ✅ | no Redo gender field |
| `channel_affinity` | — | unsupported | ➕ | no Redo equivalent |

> Redo has **no** native CLV / lifetime-spend / lifetime-AOV / churn / last-order characteristic — every predictive dimension is a per-event order proxy or a drop. This is the core "substitution" surface and why the ±10% count check matters.

---

## 3. `profile-metric` — activities ("what someone did")

### Metric → Redo `CustomerActivityType`
| Klaviyo metric | Redo activity | Tier | Proto |
|---|---|---|---|
| Placed Order | `order-placed` | exact | ✅ |
| Ordered Product | `order-placed` (collapse; no per-line-item) | substituted | ✅ |
| Started Checkout / Checkout Started | `checkout-started` | exact | ✅ |
| Added to Cart | `added-product-to-cart` | exact | ✅ |
| Viewed Product | `viewed-product` | exact | ✅ |
| Active on Site | `active-on-site` | exact | ✅ |
| Viewed Collection | `collection-viewed` | exact | ✅ |
| Received / Opened / Clicked Email | `received-email` / `opened-email` / `clicked-email` | exact | ✅ |
| Received / Clicked SMS | `received-text` / `clicked-text` | exact | ✅ |
| Subscribed to Back in Stock | `subscribed-to-back-in-stock` | exact | ➕ |
| Refunded Order | `return-processed`? | **NEEDS MICHAEL** | ➕ | Q1 |
| Cancelled / Fulfilled Order | — | **NEEDS MICHAEL** | ➕ | Q1 |
| Bounced Email / Marked Spam / Unsub Email | — / consent? | **NEEDS MICHAEL** | ➕ | Q4 (unsub) |
| Bounced/Failed SMS, Submitted Search, Shipment events | — | unsupported | ➕ | no Redo activity |

### Measurement
| Klaviyo | Redo | Tier |
|---|---|---|
| `count` | count (`ActivityCount`) | exact ✅ |
| `sum` of `$value` | at_least_once + numeric event_filter on `order_total`/`cart_subtotal` | substituted ✅ |
| `avg` / `unique` / `min` / `max` | — | unsupported ➕ (Redo count-only) |

### Comparison → `ActivityCountType`
`at least once→at_least_once`, `zero times→zero_times`, `equals N→n_times`, `not-equals→not_n_times`, `≥→at_least_n`, `>→greater_than_n`, `<→less_than_n`, `≤→at_most_n`. ✅ in `maps.ts`.

### Timeframe → Redo timeframe
| Klaviyo | Redo | Proto |
|---|---|---|
| over-all-time | `all-time` | ✅ |
| in-the-last (qty+unit) | `before-now-relative` | ✅ |
| after / before (date) | `after` / `before` | ✅ |
| between dates | `between-dates` | ➕ |
| between relative (e.g. 30–90d ago) | `between-relative` | ➕ |
| in-the-next | — (future; n/a for past events) | unsupported |

### `metric_filters[]` → Redo `event_filters[]` (NEW — proto only does the `$value` path)
| Klaviyo event property | Redo event field | Tier |
|---|---|---|
| `$value` | `order_total` (order) / `cart_subtotal` (cart) | substituted ✅ |
| Items / Name / ProductName | `product_name` (token/token_list) | ➕ |
| ProductID | `product_id` | ➕ |
| Collections / Categories | `collection_name` | ➕ |
| Brand / Vendor | `vendor` (order-placed) | ➕ |
| SKU | `product_variant_sku` | ➕ |
| Variant / VariantID | `product_variant_name` / `product_variant_id` | ➕ |
| Quantity | `quantity` (added-to-cart) | ➕ |
| Item Count | `item_count` (order-placed) | ➕ |
| Discount Codes / Total Discounts | — | unsupported ➕ |

---

## 4. `profile-marketing-consent`
| Klaviyo | Redo target | Tier | Proto |
|---|---|---|---|
| channel email, subscription subscribed | `subscribed-to-email` = true | exact | ✅ |
| channel sms, subscription subscribed | `subscribed-to-sms` = true | exact | ✅ |
| unsubscribed / never_subscribed | `subscribed-to-*` = false | exact | ✅ |
| channel email, `can_receive_marketing` | `can-receive-email-marketing` (bool) | exact | ➕ Redo has this exact dim |
| channel push | — | unsupported | ➕ |
| `is_double_optin` sub-filter | — | unsupported | ➕ |

## 5. `profile-region`
| Klaviyo | Redo | Tier | Proto |
|---|---|---|---|
| `united_states` | `country` ANY [US] | exact | ✅ |
| `european_union` | `country` ANY [27 EU ISO] | substituted | ✅ |

## 6. `profile-postal-code-distance`
→ **unsupported** (✅ drops). Redo postal-proximity is commented out; `proximity-to-city` is city-based, not postal — no clean map without geocoding.

## 7. `profile-group-membership` (list / segment)
→ `static-segment-membership` (token_list), `is_member`→ANY/NONE, when a **Klaviyo group-id → Redo segment-id** map exists (✅ shape; needs the map). This is exactly what the static-segment port produces — porting a Klaviyo list/segment to Redo yields the id mapping that resolves these conditions (and the in-flow membership gap).

---

## Redo-only characteristics (no Klaviyo segment source — won't appear in migrations)
`customer-tags`, `return-rate-value`, `return-rate-count`, `enrolled-in-loyalty-lion`, `proximity-to-city`. (Klaviyo profile "tags" aren't a segment dimension; LoyaltyLion/return-rate are Redo-native.)

---

## NEEDS MICHAEL (the genuine judgment calls)
- **Q1 — Refunded / Cancelled / Fulfilled Order metrics.** Redo has `return-processed` (Redo Returns) but no Shopify refund/cancel/fulfillment activity. Map Refunded→return-processed (approx), or drop all three?
- **Q2 — Lapsed / last-active.** Klaviyo `last_active` + `expected_date_of_next_order` have no Redo characteristic. Substitute "lapsed" via `order-placed zero_times in last N days`, or drop?
- **Q3 — Bare city.** Redo `city` needs country+state context; Klaviyo city is plain text. Assume US + best-effort (like `$region`), drop+warn, or match against a custom field?
- **Q4 — "Unsubscribed Email" metric** (the event, not consent state). Map to `subscribed-to-email = false`, or drop?

## Build gaps vs. the prototype (the ➕ rows above, summarized)
1. `metric_filters` → `event_filters` (product/collection/vendor/sku/quantity/item_count) — biggest gap.
2. Timeframes: `between-dates`, `between-relative`.
3. `can-receive-email-marketing` consent mapping.
4. Profile props: `created`→created-time, first/last→customer-name, birthday→birthday, full country→ISO table.
5. New activities: `subscribed-to-back-in-stock`.
6. Numeric `between` → two conditions.

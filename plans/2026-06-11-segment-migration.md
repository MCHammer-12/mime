# Plan: Klaviyo → Redo Segment Migration

**Status:** In Progress
**Created:** 2026-06-11

## Context
Klaviyo dynamic segments (audiences) are fully readable via the public REST API
(`GET /api/segments`, `GET /api/segments/{id}?additional-fields[segment]=definition`,
plus `additional-fields[segment]=profile_count` for the member count). Redo has a
matching dynamic-segment model and three relevant RPCs on `/marketing-rpc`:

- `createDynamicSegment` `{ name, conditions: segmentSchema }` (perm: MANAGE_SEGMENTS)
- `getSegmentCount` `{ segment: segmentSchema }` → `{ allCount, ... }` — computes a
  count from a query **without persisting**. This is the verification tool.

Structural alignment is clean: Klaviyo `condition_groups[]` are AND'd, conditions
within a group are OR'd. Redo `segmentSchema` = `{ conjunction:"AND", conditionBlocks:
[{ operator:"OR", conditions:[...] }] }`. So each Klaviyo group → one Redo block.

Redo's condition vocabulary (from `redo/model/src/marketing/segments/segment-types.ts`
+ `segment-zod-schema.ts`): `customer_attribute` (whereCondition over
CustomerCharacteristicType dimensions), `customer_activity` (event +
count{operator,value} + timeframe{type,options} + event_filters), `custom_event`.

## Approach
Three outcome tiers per Klaviyo condition:
1. **exact** — direct map (profile-property email/region, profile-metric, group
   membership, marketing consent).
2. **substituted** — no native Redo dimension, but a defensible proxy exists
   (predictive analytics: CLV / AOV / churn). Emits a human-readable "here's our
   logic instead" + must pass the ±10% count check or be operator-approved.
3. **unsupported** — no proxy (predicted_gender, expected_date_of_next_order,
   postal-code-distance). Warn; the segment imports without that condition OR is
   skipped entirely if the dropped condition is load-bearing.

### Substitution logic (predictive analytics → Redo)
- `average_order_value {op} X` → `order-placed` at_least_once, event_filter
  `order_total {op} X`. (Proxy: "has an order crossing the AOV threshold".)
- `predicted_clv` / `historic_clv` / `total_clv {op} X` → `order-placed`
  count `{op} ceil(X / AOV)` all-time. Needs merchant AOV (input or auto-tuned).
- `churn_probability >= p` → `order-placed` zero_times in last N days
  (N from p via a coarse map; auto-tuned against Klaviyo count).
- `predicted_gender`, `expected_date_of_next_order` → unsupported.

### Verification + auto-tune
`getSegmentCount` returns the Redo population for a candidate query. Compare to
Klaviyo's `profile_count`. Within ±10% → pass. For count-threshold substitutions
(CLV order-count, churn days) binary-search the threshold to land within tolerance
and report the tuned value. Else surface the gap and let the operator
import-anyway / skip / adjust the AOV.

## Sections
- `src/extract-segments.ts` — extractor
- `src/segments/klaviyo-types.ts` — Klaviyo definition types
- `src/segments/redo-types.ts` — Redo segmentSchema output types
- `src/segments/translate.ts` — translator + warnings (exact/substituted/unsupported)
- `src/segments/substitutions.ts` — predictive-analytics proxies + explanations
- `src/segments/verify.ts` — getSegmentCount client, tolerance check, auto-tune
- `src/segments/redo-client.ts` — createDynamicSegment client
- `src/segments/translate.smoke.ts` — synthetic-definition coverage smoke
- `src/segments/import-one.ts` — CLI: file/id → translate → verify → (create)
- `src/segments/batch.ts` — corpus coverage report
- Dashboard wiring (server.ts + ui) — second pass after engine is green

## Verification
- `tsc --noEmit` clean
- smoke covers all 7 Klaviyo condition types + each substitution + each tier
- `import-one.ts --diagnose` against a real account: translate + count-compare, no write
- end-to-end create against a test store, confirm count within tolerance

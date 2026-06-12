---
status: unclaimed
branch: fix/survey-metric-trigger-filter
pr: null
---

# Survey/custom-event metric mis-resolved to order_fulfilled + trigger_filter dropped

## Feedback (verbatim)

Rufskin `SURVEY COMPLETED (GV support - draft)` (Y7HwZ3), reviewer:

> The "Survey Response Completed" metric could not be migrated to Redo.
>
> Additionally, the trigger filter was neither migrated nor found in Redo. The original Klaviyo condition was:
>
> survey_code equals 689d034ddda30
>
> As for the email itself, the migration was largely successful. The only issues encountered were with the social media links, which did not clone correctly and had to be reviewed manually.

## Root cause

Two distinct gaps, both on the trigger.

### 1. The survey metric mis-resolved to `order_fulfilled`
Parse-result shows the trigger landed as `key: order_fulfilled` / `schemaType: order_tracking`. The Klaviyo trigger is a **custom survey metric** ("Survey Response Completed" — likely a Survey/Gift-card app event). mime's metric auto-resolve (`METRIC_NAME_MAP` / trigger-mapping) matched it to `order_fulfilled` — almost certainly **wrong**. A survey-completion event is not order fulfillment.

Likely files:
- [`src/flow/trigger-mapping.ts`](../../../src/flow/trigger-mapping.ts) — metric-name → Redo trigger resolution
- [`src/flow/types.ts`](../../../src/flow/types.ts) — trigger keys

Check Rufskin's `flow-Y7HwZ3/klaviyo-flow.json` for the exact metric name + ID that resolved to order_fulfilled. Either:
- A fuzzy/substring match in `METRIC_NAME_MAP` is catching "survey" → order_fulfilled incorrectly (find and tighten it), OR
- The metric is unknown and the code falls back to order_fulfilled as a default (it should NOT silently default to a real trigger — should surface for picker/skip).

### 2. trigger_filter not translated
Warning confirms:
```
"Klaviyo trigger Rr5Lfy has a trigger_filter (product/event filter) that mime doesn't yet translate at the flow [level]"
```
The Klaviyo trigger has a filter `survey_code equals 689d034ddda30` — only fire when the survey code matches. mime drops it. This is the same family as Charlie Task 9 (flow-level trigger/product filter) but for a **custom-event property filter**.

There's also a `profile_filter` "profile-property not yet translated" warning on this flow (3rd warning) — related to the broader profile-property gap (Yes Homo Task 1 handled phone-country; this is a different property).

## Proposed change

Scope: **the trigger resolution + filter for survey/custom-event metrics.** Don't try to solve all custom events.

1. **Stop the wrong auto-resolve.** From `klaviyo-flow.json`, identify why "Survey Response Completed" → `order_fulfilled`. Fix so an unrecognized custom metric does NOT silently map to a real Redo trigger. Options:
   - If Redo has a `custom_event` trigger (the error enum lists `"custom_event"` as valid) → map unknown custom metrics to `custom_event` with the event name carried in `eventName`/`triggerSpecificFields`. Confirm the `custom_event` trigger shape in redoapp + via Redo MCP.
   - If not cleanly mappable → surface in the trigger-picker (like the Reviews "Ready to review" case, SESSION-LOG 2026-05-14) so the operator chooses, instead of defaulting to order_fulfilled.
2. **Translate or surface the trigger_filter.** `survey_code equals X`:
   - If mapped to `custom_event`, carry the event-property filter if Redo's custom_event trigger supports a property match.
   - If not supportable, emit a clear `requires-action` warning naming the exact filter (`survey_code equals 689d034ddda30`) so the operator re-creates it — don't silently drop.
3. Smoke test: a synthetic survey/custom metric trigger → either `custom_event` mapping or picker/warning, NOT order_fulfilled.

## Verify

- Rufskin Y7HwZ3 re-parsed: trigger is NOT order_fulfilled. It's either `custom_event` (survey) or surfaced to the picker.
- The `survey_code equals X` filter is either translated or surfaced as a named, actionable warning.
- Regression: real order_fulfilled flows (e.g. the Order Tracking flows from prior batches) still resolve correctly — make sure tightening the match doesn't break them.

## Notes

- **Social links** ("did not clone correctly") is collapsed to the cross-merchant socials work (Castle `socials-block-missing` #90 done). Verify #90 covers Rufskin's case; if it's about link URLs (not icon detection), note it here and fold into a socials follow-up rather than expanding this task.
- The mis-resolve to a *real* trigger is the dangerous part — a survey flow silently becoming an order-fulfillment flow would fire on the wrong event if enabled. Even though imported flows land inactive (memory `feedback_flow_status_mapping`), the operator might enable it trusting the migration. Prioritize killing the silent wrong-default.
- Custom-event triggers are likely a recurring theme (survey apps, loyalty apps, quiz apps). This task is the first concrete instance — keep it scoped to survey/custom-event resolution, but the `custom_event` trigger path it establishes will be reusable.

## Done

(filled by executor on completion)

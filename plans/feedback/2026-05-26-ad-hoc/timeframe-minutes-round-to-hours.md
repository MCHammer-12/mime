---
status: unclaimed
branch: fix/timeframe-minutes-round-to-hours
pr: null
---

# Flow condition timeframe in minutes → round to nearest hour (Redo only supports hours)

## Feedback (verbatim)

Eng (via Michael, 2026-06-16), re Blackline Car Care `Viewed Product - (KLAYVIO)` flow (RbNxkM): "for one of the skip conditions, in klaviyo it is checking if they viewed a product in the last 45 minutes but we only support hours, we should make sure that it is rounding to the nearest hour."

## Root cause — confirmed from bundle

Klaviyo source (the skip condition's timeframe):
```json
{ "unit": "minutes", "value": 45, "timezone": "profile", ... }
```
mime emits it **verbatim** as minutes:
```json
{ "type": "before-now-relative", "units": "minute", "value": 45 }
```
But **Redo's condition timeframe only supports hours** (not minutes) for this skip/condition type. So a `units: minute` timeframe is unrepresentable → wrong. It must be **rounded to the nearest hour**: 45 min → **1 hour** (matches the desired Redo state Michael showed — "viewed product zero times in the last 1 hour").

mime passes minutes through in (at least) two places:
- [`condition-mapping.ts:109-120`](../../../src/flow/condition-mapping.ts) — `translateTimeframe` `in-the-last` case: `units: TIMEFRAME_UNITS[tf.unit]` (minute → minute).
- [`parser.ts:680-681`](../../../src/flow/parser.ts) — the browse-abandonment skip-condition window (also yields `minute`). `extractFirstTimeDelayWindow` (parser.ts:117-133) likewise returns `minute`.

## Proposed change

Round **minute** timeframes → **nearest hour** wherever mime emits a `before-now-relative` condition/skip-condition timeframe (Redo only supports hour/day there):
- `hours = Math.round(minutes / 60)` → emit `{ units: "hour", value: hours }`.
- **Edge: sub-30-min rounds to 0 hours**, which is meaningless — floor at **1 hour** (a "viewed in the last <30 min" intent is closest to "1 hour", never "0"). Confirm with eng if they'd rather floor differently, but min 1 is the safe default.
- Emit a `degraded-mapping` warning noting the rounding (e.g. `viewed-product timeframe 45 min → rounded to 1 hour (Redo supports hours only)`), since it's a fidelity loss.
- **Centralize** so both emission points (condition-mapping `translateTimeframe` + parser skip-condition window) round consistently — a single `roundTimeframeToSupportedUnit()` helper, applied wherever a condition timeframe is built. Don't touch WAIT step durations (those support minutes/hours/days — this is specifically condition/skip-condition timeframes).

## Verify

- Blackline RbNxkM re-parsed: the viewed-product skip condition emits `{ units: "hour", value: 1 }` (was `minute`/45), with a degraded-mapping warning.
- Smoke: 45 min → 1 hr, 90 min → 2 hr (rounds), 20 min → 1 hr (floored, not 0), 60 min → 1 hr; hour/day timeframes unchanged.
- Regression: `condition-mapping.smoke.ts` existing timeframe cases (the `in-the-last` quantity/unit case, day windows) unchanged; batch-test 416/0.

## Notes

- **Cross-merchant** — any Klaviyo flow with a sub-hour condition window hits this (viewed-product, added-to-cart, etc.). Not Blackline-specific.
- The WAIT-step time-of-day/weekday degraded-mapping is a *separate* accepted gap (memory `feedback_migration_decisions`) — this task is only about condition **timeframe units**, not WAIT scheduling.
- **Also in this bundle (separate finding, not this task):** Michael noted "universal blocks were not successfully migrated" — Klaviyo *universal/saved content blocks* didn't carry; he had to rebuild them in Redo. Triage separately (Content cluster) — needs the template HTML to see how the universal block renders.

## Done
(filled by executor)

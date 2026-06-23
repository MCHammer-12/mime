---
status: done
branch: fix/carry-smart-sending-bypass
pr: 134
---

# Klaviyo `smart_sending_enabled: false` not carried to Redo (only warned)

## Finding (2026-06-23, from queue review)

When a Klaviyo flow message has `smart_sending_enabled: false` (bypass the
"don't re-send within N days" throttle = always send), mime only emitted a
`requires-review` warning and **never set the Redo equivalent**. The trigger
type has `shouldSkipSmartSending?: boolean` but mime never assigned it — so the
merchant's "always send" intent was silently lost.

## Redo expectation — confirmed against origin/main (local redoapp ~9640 behind)

`shouldSkipSmartSending` is on the trigger step, `z.boolean().nullish()`
(`advanced-flow-db-parser.ts:272`), mongoose `default: false`
(`AdvancedFlow.ts:81`). Send-time logic
(`redo/marketing/service/.../recipient-validation.ts:823`):
```ts
if (shouldSkipSmartSendingForTriggerKey(trigger)) return true;   // by KEY
return !!triggerStep.shouldSkipSmartSending;                     // else honor field; null→false
```
`shouldSkipSmartSendingForTriggerKey` → **true** for order-tracking,
return-tracking, MARKETING_CAMPAIGN, EMAIL/SMS_SIGNUP, BACK_IN_STOCK, recharge
upcoming-charge, OMS fulfillment; **false** for everything else (abandonment
cart/checkout/browse, date, custom-event, segment, list, price-drop). For the
false set the per-step field is honored and defaults to throttle-on.

**Memory correction:** `project_redo_smart_sending_skip_conditions` claimed
"abandonment automations need shouldSkipSmartSending (default on)" — that's
wrong; abandonment is in the false set. The `isCartAbandoned==false` skip
condition (separate mechanism) part of that memory stands.

## Change (shipped)

`src/flow/parser.ts`:
- Track per-flow on `ParseState`: `smartSendingBypass` (any message had
  `smart_sending_enabled: false`) and `smartSendingThrottled` (any didn't).
- The two per-message warnings (send-email + send-sms) are replaced by flag-sets.
- After the action loop, if `smartSendingBypass` → set
  `triggerStep.shouldSkipSmartSending = true`. If also `smartSendingThrottled`
  (mixed flow — Redo is flow-wide, can't do per-message) → one `requires-review`
  warning.
- Never sets `false` — so it can't worsen throttle-on flows; no-op for
  always-bypass keys.

## Verify (done)
- `src/flow/smart-sending.smoke.ts`: bypass→field true (no warn); all-on→omitted;
  mixed→true + warn. 3/3.
- All flow smokes green; `batch-test` 416 / 0 failed; 0 new tsc errors.

## Done
Shipped — see PR. Memory `project_redo_smart_sending_skip_conditions` updated to
correct the abandonment-default claim.

# Order tracking ads: billing design

Status: riff / options, not a decision. Owner: Austin. Date: 2026-09-02.

## TL;DR

The ads product is built. The billing for it is not. Everything below is about
closing that gap.

What exists in `redoapp/redo` today:

| Piece | Where |
| --- | --- |
| Three offer networks: Rokt, Falcon (white-labeled "Redo Offer Network"), Uptick | `redo/integrations/definitions/common/src/offer-network/offer-placement.ts` |
| Five surfaces: tracking-page, returns-confirmation, hosted-page, shopify-thank-you, shopify-order-status | `OfferPlacementSurface` |
| `OFFERS` block on the tracking page builder | `redo/order-tracking/common/src/tracking-page-definition.ts` |
| Shopify extensions for thank-you and order-status | `redo/shopify/app/thank-you-offers-ui`, `order-status-offers-ui` |
| Daily revenue sync from providers | `offer_network_daily_metric` table, `syncOfferNetworkMetricsTask` cron |
| Merchant data-sharing consent attestation | `OfferNetworkDataSharingConsent` on team settings |
| Analytics metric for offer clicks | `order_tracking_page_offer_clicks` |

What does not exist:

1. Any `BillingCharge` written from offer revenue. The metrics table is
   reporting-only. Zero dollars flow from ad revenue into billing.
2. Any record of when a merchant turned ads on or off. `OfferNetworkSettings`
   is current-state only, no history.
3. Any detection of silent disablement (toggle on, nothing serving).
4. Any rate-card switch tied to ad enablement.

## The commercial shape (decide this first)

Everything downstream depends on which of these we are actually selling. This is
a leadership call, not an engineering one, and it changes the schema.

| Shape | Merchant gets | Redo gets | Build cost |
| --- | --- | --- | --- |
| **A. Ads-subsidized** | Order tracking free or discounted | 100% of ad revenue | Low. No payout rail. |
| **B. Rev share** | A cut of ad revenue as bill credit or cash | The rest | High. Credits, payout, tax. |
| **C. Placement fee** | Keeps ad revenue | Flat per-placement fee | Low, but caps our upside on the merchants who perform best. |

**Recommendation: A for v1.** It needs no payout rail, no tax questions, and it
gives us the cleanest merchant pitch: "we monetize the impressions you were not
using, and your order tracking gets cheaper." B can be layered on later by
writing a credit charge, since the ledger design below already carries gross
revenue per window.

The rest of this doc assumes A.

## Problem 1: Revenue tracking

### What we get from the providers

`offer_network_daily_metric` grain is `(account_id, provider, day, placement_id)`
carrying `clicks`, `transactions`, `revenue_minor`, `revenue_currency`,
`extra_metrics`, `synced_at`.

Three properties of this data drive the whole design:

- **Daily, not per-order.** No provider gives us "this order earned $0.14." We
  cannot attribute a dollar to an order, only to a placement-day.
- **Lagged.** Revenue for day D lands 1 to 3 days later depending on provider.
- **Restated.** Providers revise prior days after the fact (fraud clawbacks,
  reconciliation). A day is never truly final.

### Options

**Option 1: Daily sync only (status quo plus billing).**
Bill straight off `offer_network_daily_metric`.
Pro: already built, works for all three providers, cheap.
Con: no denominator. We cannot tell "ads earned nothing because traffic was low"
apart from "ads earned nothing because the block stopped rendering." That
distinction is the whole of Problem 3.

**Option 2: Our own event stream.**
Write an `offer_impression` row on every render and click from our surfaces.
Pro: per-order attribution, real audit trail, and we own the denominator.
Con: high write volume on every tracking page view, and revenue allocated down
to an order is an estimate we invented, not a number a provider will back in a
dispute.

**Option 3 (recommended): daily revenue is the money, events are the denominator.**

- Provider daily revenue stays the single source of billing truth. Never
  re-derive money from our own counters.
- Our own impression counter (aggregate per placement-day, not per event) tells
  us whether the placement was actually serving. This powers RPM, the enablement
  check, and the alert.
- Aggregate counter, not a row per view. A daily rollup keyed
  `(account, surface, provider, placement, day)` with `impressions` is enough
  and costs one upsert per page view against a hot key, or a batched counter.

### Rokt reports nothing. That is a hole in the revenue model.

`report-sources.ts` maps each provider to a reporting feed, and one of the three
is null:

| Provider | Reporting feed | Consequence |
| --- | --- | --- |
| Falcon | `falconReportSource` | Revenue syncs daily |
| Uptick | `uptickReportSource` | Revenue syncs daily |
| **Rokt** | **`null`** | **No partner reporting API. We never see a dollar.** |

The comment in the file is explicit: "Merchant-entered integration; Rokt exposes
no partner reporting API to us." A Rokt placement is set up with a page
identifier the merchant gets from their own Rokt contact, and the revenue
relationship is between the merchant and Rokt.

This breaks shape A for Rokt merchants specifically. If Redo keeps 100% of ad
revenue in exchange for discounting order tracking, a Rokt merchant gets the
discount while Redo collects nothing and cannot even measure what it gave up.

Three ways to handle it, and this needs deciding alongside the commercial shape:

1. **Do not offer the subsidy on Rokt.** Cleanest. Rokt stays a merchant-owned
   integration Redo hosts, and order tracking bills at the standard rate.
2. **Subsidize on fill rate alone, not revenue.** The impression rollup is ours,
   so we can still prove a Rokt placement is serving even with no revenue feed.
   Bill coverage-prorated, skip the rev-share charge entirely.
3. **Get reporting from Rokt.** A partnership conversation, not an engineering
   one, and it does not unblock anything this quarter.

Option 2 is worth noting because it is only available thanks to the fill-rate
design. A revenue-only model has no way to tell a serving Rokt placement from a
removed one.

### The restatement rule

Borrow the pattern already proven in checkout-optimization billing
(`ccb__explain_order` splits `recorded` from `current`):

> Billing truth is what was snapshotted when the window closed. A provider
> restating an earlier day never rewrites a closed charge. It lands as a
> separate adjustment charge in the next open window.

`billing_charge_subtype.order_tracking_adjustment` already exists for exactly
this, and `BillingCharge.reverses_charge_id` links the adjustment to what it
corrects. This is what makes "why did my invoice change" answerable six months
later.

### "Just basic invoicing?" No, and it is two separate money flows

**Provider to Redo.** For Falcon and Uptick, the network pays Redo. Ad networks
remit on their own statement, net-30 or net-60, off their own numbers. Redo does
not invoice them; Redo reconciles. Monthly per provider:

```
expected = sum(revenue_minor) over the month from offer_network_daily_metric
received = the provider's remittance
delta    = restatement or clawback, carried into next month
```

That is a receivable ledger, one row per provider per month, and it is
finance-facing. It never touches a merchant invoice. Confirm on each contract
who the payee is: for Rokt it is the merchant, which is the whole Rokt problem.

**Redo internal revenue tracking.** "What are merchants making us" is a monthly
rollup per merchant: attributed provider revenue times Redo's share. It has to
land in Snowflake to be useful, and `offer_network_daily_metric` is not
replicated there today (`SHOW TABLES LIKE '%OFFER_NETWORK%'` returns nothing,
while every other CRDB billing table is present as `STG_CRDB_*`). Replicating
the table is the first task on this list, and it is a data-eng ticket, not a
product one. Once it is there, the existing Revenue and Rev_Ops semantic views
can answer the question.

**Redo to merchant.** Under shape A nothing is invoiced for ad revenue. The
merchant's bill changes only in that order tracking gets credited. See
"Reverting the rate" below for the credit-line shape.

### The credit row

Per window, write one `BillingCharge` as a negative credit against the standard
order-tracking charges. Every column it needs already exists.

| Column | Value |
| --- | --- |
| `type` | `OrderTracking` (exists) |
| `charge_subtype` | `offer_network_subsidy_credit` (**new enum value**) |
| `amount` | `-(standardCharges) * onDays / daysInWindow` |
| `recovered_revenue` | Gross ad revenue for the window, informational. Column already exists, used by Recover for exactly this. |
| `breakdowns` | JSON: per-placement, per-day, per-surface rows so the invoice line is explainable without a query. |
| `idempotency_key` | `offer-subsidy:{accountId}:{windowId}` |
| `product` | `SubscriptionProduct.OrderTracking` |

No new table for the money. See "Reverting the rate" for why this is a credit
and not a second rate card.

## How every other Redo product turns into revenue

Source of truth is `BillingWindow` (the per-window snapshot), `BillingCharge`
(the charge row), and `invoice-type-mapping.ts` (product to charge type). Across
all 21 `SubscriptionProduct` values there are only **six** mechanics.

| # | Mechanic | How it bills | Products |
| --- | --- | --- | --- |
| 1 | **Period fee** | Flat fee per window, snapshotted at window open into `<product>_period_fee_cents` | Nearly all. Order tracking, CHOP, Recover, Returns, AEO, IMS, IMS Forecasting, Marketing SMS/Email each have their own column. |
| 2 | **Metered, included + overage** | `included_orders` / `included_shipments` / `included_sms_credits` / `included_email_credits`, then `overage_*_price_micros` beyond | Order tracking, Marketing SMS/Email, Support AI/Voice usage |
| 3 | **Per-unit gated on proof of work** | Bill per order, but only where a qualifier proves Redo did something. Highest-rate-wins across qualifiers. | Checkout optimization |
| 4 | **Revenue share on attributed value, with clawback** | Attribute revenue to the product, take `revenue_share_percentage`, give it back if the order is later returned or cancelled | Recover, coverage products (PP+, FSR, return coverage) |
| 5 | **Cost-plus markup** | Buy at carrier rate, sell at rate plus `upcharge`. `carrier_fees_micros` tracks our cost separately from the charge. | Return labels, outbound labels, pickups |
| 6 | **Success fee** | Only bill on a win. `min_fee_dollars` plus `fee_percentage` of the amount recovered. | Disputes |

### What order tracking bills today

This is the rate card ads would subsidize and the one a revert falls back to.
From `orderTrackingOverviewSchema`, it is mechanics 1 and 2 together:

- `order_tracking_period_fee_cents`, the platform fee
- Included and overage on **orders**, **shipments**, **SMS** and **email**
- SMS carrier fees passed through separately
- Charge type `Usage`, subtype `OrderTracking`

So an ads-subsidized merchant is not getting one number waived. They are getting
a period fee plus four metered lines waived, and the revert has to restore all
of it. "What rate do we revert to" is therefore not one number, it is their
whole snapshotted rate card. That is why the subsidy is a credit against
charges that are already written, never a substitute rate card.

### Where ads fits: mechanic 4, with one difference that matters

Recover is the direct precedent. It already handles everything ads needs:
attributed revenue on a lag, a share percentage, and clawbacks when the
attributed order comes back. `recoverOverviewSchema` carries
`recoveredRevenueDollars`, `recoveredOrdersCount` and `revenueSharePercentage`;
`recoverReturnClawbackDetailsSchema` and
`recoverCancellationClawbackDetailsSchema` carry the reversals.

One difference decides the design: Recover attributes revenue we can see
ourselves, at order grain, in Shopify. Ad revenue arrives from a third party at
placement-day grain, and we never see the shopper transaction at all.

That is why ads cannot reuse Recover's attribution, only its **billing** shape.
And it is why the clawback path is not optional: providers restate and claw back
for fraud exactly like a returned order does. Model an ad clawback on
`recoverReturnClawbackDetails`, not as something new.

## Problem 2: Fallback billing

"Ads on" has to change what the merchant pays, and "ads off" has to change it
back. Three ways to structure that.

**Option A: Floor / minimum guarantee.**
Merchant is billed $X/mo for order tracking. Ad revenue credits against it, up
to $X. Underperformance means the merchant pays the difference.
Pro: Redo revenue is stable and predictable. Safest.
Con: merchant sees a variable bill they cannot forecast, which is the single
most common source of billing support tickets.

**Option B: Cliff.**
Ads on means order tracking is $0. Ads off means full rate. No proration.
Pro: trivial to explain and to build.
Con: trivially gamed. Turn ads on the 1st, off the 2nd, pay nothing. Requires a
coverage-days test anyway, at which point you have built Option C.

**Option C (recommended): coverage-ratio proration.**
Bill the standard rate scaled by the fraction of the window ads were off:

```
charge = standardMonthlyRate * (offDays / daysInWindow)
```

Pro: fair in both directions, hard to game, and the merchant conversation is
simple ("you pay for the days you were not monetizing").
Con: needs the enablement ledger below, and needs a definition of "off" that
survives an argument.

**Recommendation: C, with A as the safety net.** Coverage proration handles the
merchant who switches off. The floor handles the merchant who leaves ads on but
earns nothing, whether from low traffic or from quietly suppressing the block.

### Defining "on" so it cannot be gamed

A settings boolean is not a definition. A merchant can leave the toggle on and
hide the block with one line of CSS. Ads count as ON for a given day only when
all of these hold:

1. A placement is configured for the surface.
2. `dataSharingConsent` is present and not revoked.
3. The provider integration is connected, and for Falcon `isLiveMode` is true.
   Falcon in test mode serves mock offers and earns nothing.
4. The fill rate for that placement-day clears the floor. See below.

### Fill rate, not an impression threshold

The first instinct is "we should see at least N impressions a day." That is the
right idea with the wrong shape, because N is unknowable across merchants: a
brand doing 40 orders a day and one doing 40,000 cannot share a threshold, and
any N picked for one is either a false alarm or a loophole for the other.

Use a ratio. We render the page, so we already know the denominator:

```
fillRate = adImpressions / eligiblePageViews
```

| Reading | Meaning | Action |
| --- | --- | --- |
| `fillRate` near 1 | Serving normally | Bill as ads-on |
| `fillRate` near 0, `eligiblePageViews > 0` | The page ran and the ad did not. Ads are off or broken. | Mark `degraded`, start the alert clock |
| `eligiblePageViews == 0` | No traffic, so no signal either way | Carry yesterday's state forward. Never alert, never bill as off. |

### Both halves of the ratio already exist

The tracking page already emits both numbers into the shopper-event stream, and
the analytics catalog documents them
(`tracking-page-event-grain-attributes.ts`):

| Event | Fired when | Role |
| --- | --- | --- |
| `TRACKING_PAGE_VIEWED` | The page rendered in front of a shopper | Denominator |
| `TRACKING_PAGE_CLICKED` with click target `offer-impression` | "The moment a third-party offer-network placement finishes rendering" | Numerator |

`offers.tsx` raises the impression after `mountOfferPlacement` resolves, with
`url: block.provider`, so it is split by provider and it fires for Rokt too.
That is what makes the Rokt option below possible.

Three caveats from the code:

1. It is "SDK mounted," not "creative visible." Falcon resolves after
   `sdk.init`, Rokt after `selectPlacements`, Uptick immediately after
   `uptick("init")`. Good enough for "the merchant is using ads," which is the
   question. It is not a viewability metric.
2. It carries `trackingPageId` but not `placement_id`. Add the placement to the
   event so the numerator joins `offer_network_daily_metric` cleanly.
3. It fires on the tracking page only. The Shopify thank-you and order-status
   extensions (`thank-you-offers-ui`, `order-status-offers-ui`) are separate
   code and do not log it. That is the one piece of new instrumentation.

Falcon test mode (`isLiveMode: false`) still renders mock offers and still
fires the impression. Impressions alone cannot catch a merchant parked in test
mode earning nothing, which is why "on" is four conditions and not one.

So build step 1 shrinks from "instrument impressions" to "a daily rollup over
events we already have, plus one event in the Shopify extensions." Days, not a
week.

### The 48-hour rule

Two consecutive days of `fillRate` below the floor with views above zero, and
the placement is `degraded`. Two consecutive days of zero views is no signal;
hold state. The denominator is what makes 48 hours safe: without it, a quiet
weekend at a small merchant looks identical to a removed block.

Bill from the first zero day, not the third. The 48 hours are there to keep the
alert quiet, not to give away two days. If the block was gone on Monday, it was
gone on Monday.

## Problem 3: The switch, the alert, the revert

### The enablement ledger

Replace "is there a boolean on the team doc" with an append-only table:

```
offer_network_enablement_event(
  account_id,
  surface,        -- OfferPlacementSurface
  provider,       -- offer_network_provider
  placement_id,
  state,          -- enabled | disabled | degraded
  reason,
  actor,          -- user id, or 'system'
  effective_at,
  detected_at
)
```

`degraded` is the state that earns its keep: configured and consented, but not
actually serving. It is neither "the merchant turned it off" nor "everything is
fine," and collapsing it into either one is how this ships broken.

Two timestamps, not one. `effective_at` is when the world changed;
`detected_at` is when we noticed. Coverage proration uses `effective_at`. The
alert SLA is measured on the gap.

Reasons worth enumerating up front: `merchant_toggle`, `block_removed_from_page`,
`placement_deleted`, `consent_revoked`, `integration_disconnected`,
`falcon_test_mode`, `zero_impressions`, `provider_reporting_gap`.

### Three detection paths, three latencies

| Path | Trigger | Latency | Notes |
| --- | --- | --- | --- |
| **Explicit** | Merchant flips the setting, deletes the OFFERS block, or revokes consent | Synchronous | Write the ledger event in the same transaction as the settings write, or it will drift. |
| **Structural** | Integration disconnected, placement deleted, Falcon flipped to test mode, block absent from the published page | Daily reconciler | Cheap. Reads config, no traffic data needed. |
| **Silent** | Settings look correct, impressions went to zero | Daily reconciler on impressions plus `offer_network_daily_metric` | The one that will actually bite us, and the one nobody builds. |

### Alerting

- Fire on the **third** consecutive `degraded` day, not the first. Providers have
  reporting lag and restate. A day-one page is a false-positive generator that
  gets muted within a week, and a muted alert is worse than none.
- Route to the CSM, not to engineering. This is a revenue event, not an outage.
- Include the last 14 days of revenue and impressions in the alert body. The CSM
  needs to open the merchant conversation already knowing the number.
- Separate the two cases in the alert copy. "Merchant turned ads off" is a
  save conversation. "Ads are on and earning nothing" is a technical
  investigation. Same alert channel, different first message.

### Reverting the rate: a credit line, not a second rate card

The constraint: rates are snapshotted onto the billing window when it opens.
Changing settings mid-window does nothing until the next one. Reverting cannot
be a mid-window rate change.

An earlier draft of this doc proposed snapshotting two rate cards per window and
apportioning between them at close. There is a simpler shape that uses only what
exists:

1. **Always write the standard order-tracking charges.** They are already
   snapshotted on every window (`order_tracking_period_fee_cents`, the four
   metered lines). Nothing changes here.
2. **Write one prorated credit against them.** New subtype
   `offer_network_subsidy_credit`, negative amount:

   ```
   credit = -(standardCharges) * onDays / daysInWindow
   ```

   `onDays` comes from the enablement ledger.
3. **Revert is the credit shrinking.** A merchant who turns ads off on the 10th
   of a 30-day window gets 9/30 of the credit. Nothing is reconstructed, no
   second card, and the standard charge is on the invoice every month whether
   ads are on or not.

This is how `FreeTrialCredit`, `PromotionalCredit` and `MerchantIncentive`
already work, so finance sees a familiar shape: gross revenue on one line,
contra-revenue on the next. The credit row carries `recovered_revenue` (gross
ad revenue for the window) and `breakdowns` (per placement-day), so the
merchant's invoice can say "Ad revenue earned: $X. Order tracking credit: $Y."

The old two-card idea is retired. It solved the same problem with more state.

## Problem 4: Design options for the ad placements

### How plausible is letting merchants restyle the ad?

Two different things, and the answer is opposite for each.

**Inside the creative: not controllable from our side today.**
`ResolvedOfferConfig` carries no styling for any provider. The three SDK calls
take exactly these inputs and nothing else:

| Provider | Call | Styling params |
| --- | --- | --- |
| Falcon | `FalconAds.init({ apiKey, containerId, placementId, attributes })` | None |
| Rokt | `launcher.selectPlacements({ attributes, identifier })` | None. Rokt layouts are styled in Rokt's own dashboard, per page identifier. |
| Uptick | `uptick("init", container, { ...attributes, app_id, site_id })` | None |

Fonts, button colors or fills inside the ad need each provider to expose a
theming API. Falcon is white-labeled as "Redo Offer Network," so that is the one
where asking is realistic. Rokt is merchant-configured on Rokt's side; the most
we can do is deep-link them there. Uptick already leaks an unscoped stylesheet
onto the host page, so giving it more styling surface is the wrong direction.

**Around the creative: fully ours, and cheap.**
The OFFERS block schema is `base + { provider, offerPlacementId }` and nothing
else, and on the live page it renders with no wrapper at all (`offers.tsx`
returns the bare container in the customer portal). The page already carries
`typography` (header and body font family, color, size, weight),
`badgeSettings` and `buttonBorderRadius`, and every other block applies them.
OFFERS opts out.

A "frame" option set that costs about a week and cannot break the ad:

| Option | Source | Notes |
| --- | --- | --- |
| Heading above the ad | New field, styled by page `typography.header*` | "Offers you might like" and the like |
| Background color | New field | Behind the creative, not inside it |
| Padding, border, corner radius | New fields | Same controls other blocks have |
| Alignment and max width | New field | Within the Falcon 580x260 floor |

Integrity of the original ad is guaranteed by construction here because the
creative is untouched. Going inside it is a provider negotiation, not a build.

### Where the ads go

The user-visible question. Ranked by revenue potential against brand risk.

| Option | Surface | Revenue | Brand risk | Notes |
| --- | --- | --- | --- | --- |
| Offers block below the fold | Tracking page | Medium | Low | What ships today. Safe default. |
| Above-the-fold slot in the hero | Tracking page | High | High | Highest RPM, highest merchant churn risk. |
| Interstitial on confirmation | Shopify thank-you | High | High | Interrupts the post-purchase moment. Test carefully. |
| Inline in the tracking timeline | Tracking page | Medium | Medium | Reads as content, not as an ad. Good middle ground. |
| **Merchant upsell first, ads as fill** | Both | Medium-High | Low | See below. |

**Recommendation: fill-order, not a fixed slot.** Redo already has
`PRODUCT_UPSELL` and `SUBSCRIPTION_UPSELL` blocks and a
`post_purchase_upsell_accepted` billing qualifier. The merchant's own offer
should always win the slot; ads fill only what the merchant left empty. That
protects the brand, removes the "you are selling my customers to competitors"
objection, and turns the pitch into "we monetize impressions you were not using."

Hard constraint to design around: Falcon requires a 580x260 desktop minimum,
which is why `DEFAULT_BLOCK_SIZES[OFFERS]` is 4 columns by 2 rows. There is no
compact ad unit available for Falcon. Any "small ad" mock will not render.

Second constraint: Uptick is currently disabled on `TRACKING_PAGE` because its
`offers.js` appends an unscoped form reset that breaks merchant page styling.
Tracking-page ads are Rokt and Falcon only until Uptick scopes that stylesheet.

## Build order

0. **Replicate `offer_network_daily_metric` to Snowflake.** Data-eng ticket.
   Nothing about internal revenue tracking works without it. ~days.
1. **Fill-rate rollup.** Daily `TRACKING_PAGE_VIEWED` vs `offer-impression` per
   placement-day from events that already exist, plus the same impression event
   in the two Shopify extensions, plus `placement_id` on the event. ~3 days.
2. **Enablement ledger plus explicit detection.** Table, plus writes on every
   settings and tracking-page-block mutation. ~1 week.
3. **Structural and silent reconcilers plus the alert.** Daily job, 48-hour
   rule, CSM routing. ~1 week.
4. **The credit.** New `offer_network_subsidy_credit` subtype, window-close job
   writing one prorated credit with breakdowns. ~1 week including invoice
   display.
5. **Provider reconciliation ledger.** Expected vs received per provider per
   month. Finance-facing. ~3 days.

Steps 0 through 3 are worth doing whatever the commercial model turns out to be,
because they are the measurement layer. Steps 4 and 5 wait on the answer to the
first question below.

## Open questions

1. **Shape A, B, or C?** Blocks steps 4 and 5. Everything else can proceed.
2. **Is order tracking free under ads, or discounted?** Free is a cleaner pitch
   and makes the coverage ratio the entire bill. Discounted keeps a revenue floor
   but makes the invoice harder to read.
3. **Who is the payee on each provider contract?** Falcon and Uptick should pay
   Redo for the subsidy model to work. If any contract names the merchant, that
   provider joins Rokt in the fill-rate-only bucket.
4. **Is 0.5 the right fill-rate floor?** Lower risk than picking an absolute N,
   but still worth checking against two weeks of real placement-day data before
   it gates a bill.
5. **Who owns the CSM alert?** An alert with no owner is a muted channel.
6. **What do we do about Rokt?** No reporting feed exists, so a Rokt merchant
   cannot be revenue-shared. Decide alongside the commercial shape, not after.

## What I would not do

- Do not attribute ad revenue to individual orders. The providers do not report
  at that grain, and an invented allocation will lose the first dispute it meets.
- Do not mutate a closed charge when a provider restates. Adjust forward.
- Do not gate on a settings boolean alone. It is the one signal a merchant can
  leave true while serving nothing.
- Do not build a per-event impression table when a daily rollup answers every
  question we have.
- Do not count impressions without counting eligible page views. A numerator
  with no denominator cannot tell a quiet day from a broken one.
- Do not invent an ad clawback path. Providers restate exactly like orders get
  returned, and Recover's clawback shape already handles it.

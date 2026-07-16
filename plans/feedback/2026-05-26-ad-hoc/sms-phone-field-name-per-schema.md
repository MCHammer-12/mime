---
status: done
branch: fix/sms-phone-field-name-per-schema
pr: 146
priority: HIGH — SMS steps carry wrong phone-field reference for some triggers
---

**SHIPPED in [#146](https://github.com/MCHammer-12/mime/pull/146):**
`phoneFieldForSchema(schemaType)` → `customerPhoneNumber` for
`sms_marketing_signup`, `customerPhone` otherwise (all current types unchanged →
zero regression). Full per-schemaType audit of the remaining SMS-capable types
(price_drop, warranty, order_tracking) is still open below if a future case
surfaces, but the reported signup bug is fixed.

# send_sms `phoneNumberFieldName` is hardcoded — should be per-schemaType

## Feedback (verbatim)
Michael (2026-07-16): a flow's `send_sms` step saved `phoneNumberFieldName:
"customerPhone"`; the correct field name is `customerPhoneNumber`.
`recipientNameFieldName: "customerFirstName"` is correct.

## Diagnosis
mime hardcodes the SMS recipient field at
[src/flow/parser.ts:401](../../../src/flow/parser.ts):
```
phoneNumberFieldName: "customerPhone",
```
for **every** send_sms step, regardless of the flow's `flowSchemaType`. mime
emits many schemaTypes (see [marketing-trigger-options.ts](../../../src/flow/marketing-trigger-options.ts)):
abandonment (cart/checkout/browse), sms_marketing_signup, back_in_stock,
low_inventory, segment_membership, date, price_drop, warranty, …

In Redo, `phoneNumberFieldName` is a **reference to a field on the flow's data
schema** (`send_sms` step schema is `phoneNumberFieldName: z.string()` — no
enum, no default, so a wrong name imports silently and the send-time lookup
`schemaInstance[phoneNumberFieldName]` just returns undefined → no phone). The
right name therefore **depends on the flow's schemaType.**

### Verified against redoapp live schema (`redo/flows/common/src/schemas/marketing/marketing.ts`)
Top-level phone field per marketing schema:

| schemaType | phone field |
|---|---|
| MARKETING_CART_ABANDONMENT | `customerPhone` |
| MARKETING_CHECKOUT_ABANDONMENT | `customerPhone` |
| MARKETING_BROWSE_ABANDONMENT | `customerPhone` |
| non-Shopify / CommentSold abandonment variants | `customerPhone` |
| MARKETING_BACK_IN_STOCK | `customerPhone` |
| MARKETING_LOW_INVENTORY | `customerPhone` |
| MARKETING_SEGMENT_MEMBERSHIP_CHANGE | `customerPhone` |

So for **abandonment (the bulk of SMS migrations), mime's current `customerPhone`
is CORRECT.** A blanket rename to `customerPhoneNumber` would BREAK every
abandonment SMS flow (the field `customerPhoneNumber` does not exist on those
schemas → undefined phone → silent no-send). This is the trap to avoid.

### CONFIRMED (Blackline Car Care, 2026-07-16)
Michael's flow "SMS POP UP FLOW" is `schemaType: "sms_marketing_signup"`.
Redo's `smsMarketingSignupSchema` (marketing.ts) defines the phone field as
**`customerPhoneNumber`** (`dataType: "Phone"`, doc "…customer who signed up for
marketing SMS"). `baseMarketingSmsSchema` also uses `customerPhoneNumber`. So:

| schemaType | phone field |
|---|---|
| **SMS_MARKETING_SIGNUP** | **`customerPhoneNumber`** ← mime emits `customerPhone`, WRONG |
| MARKETING_CART/CHECKOUT/BROWSE_ABANDONMENT (+ non-Shopify) | `customerPhone` (mime correct) |
| MARKETING_DATE | `customerPhone` |
| MARKETING_BACK_IN_STOCK | `customerPhone` |
| MARKETING_LOW_INVENTORY | `customerPhone` |
| MARKETING_SEGMENT_MEMBERSHIP_CHANGE | `customerPhone` |
| EMAIL_MARKETING_SIGNUP | (no phone field — email only) |

Rule of thumb: the **SMS-native** marketing schemas use `customerPhoneNumber`;
the email-first schemas that also carry a phone use `customerPhone`. Executor
should build the full `schemaType → phoneFieldName` map from redoapp's `schemas`
registry (each schema has one Phone-typed field) rather than trust this partial
table.

### Noted (likely NOT a bug) — same merchant
Blackline's **"1KMH | Customer Winback | SMS"** flow imported as
`schemaType: "order_tracking"`. Michael's read: it was probably an **order-delivered**
Klaviyo trigger, in which case `order_tracking` is correct (winback timed off
last delivery). Not treating as a bug. If any order_tracking flow with an SMS
step turns up a wrong recipient phone, revisit order_tracking's phone field in
the per-schemaType audit above — but no action needed now.

## Proposed fix (clean, self-correcting)
Don't hardcode. Derive `phoneNumberFieldName` from the flow's `flowSchemaType`
by looking up that schema's phone-typed field (each marketing schema has exactly
one top-level `Maybe Phone` field). Same idea already used for the template
`schemaType`. A small `schemaType → phoneFieldName` map (sourced from redoapp's
`schemas` registry) is the low-risk version; the map's abandonment rows stay
`customerPhone`, and Michael's flow's row becomes whatever that schema defines.

Do the same audit for `recipientNameFieldName` (currently `customerFirstName` —
which IS a field on the base marketing schema, so likely fine, but confirm per
schemaType while we're here).

## Verify
- Abandonment SMS flow → `customerPhone` (unchanged), sends.
- Michael's flow's trigger → the schema's real phone field, sends.
- No schemaType emits a phone field name absent from its schema.

## Done
(filled by executor)

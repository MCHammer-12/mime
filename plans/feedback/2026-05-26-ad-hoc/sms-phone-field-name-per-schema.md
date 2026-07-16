---
status: needs-input
branch: fix/sms-phone-field-name-per-schema
pr: null
priority: HIGH — SMS steps carry wrong phone-field reference for some triggers
---

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

### Open item
I could NOT find a top-level `customerPhoneNumber` field in any Redo marketing
schema I read. Michael's flow must be a schemaType whose phone field IS
`customerPhoneNumber` (strong candidate: `SMS_MARKETING_SIGNUP` welcome flow, or
date/price_drop). **Need: which trigger is the flow Michael saw** → then verify
that schema's phone field in redoapp before changing anything.

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

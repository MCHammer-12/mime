# Flow-import error classes + fixes

Catalog of `createAdvancedFlow` / `createEmailTemplate` failures seen in flow
imports, with the root cause and the fix. Add new shapes as they appear.

## 1. `phoneNumberFieldName references "X", which is not a field on schema "Y"`
**Cause:** a `send_sms` step references a phone field the flow's trigger schema
doesn't have. Redo's `validate-step-field-references.ts` rejects it → 400 → the
whole flow fails. The phone field is **per-schema**:
- most marketing schemas → `customerPhone`
- `sms_marketing_signup` → `customerPhoneNumber`
- `email_marketing_signup` → **no phone field at all** (it only has `customerEmail`)

**Fix (shipped):** `smsPhoneFieldForSchema()` in `src/flow/parser.ts` picks the
right field, and for `email_marketing_signup` **drops the send_sms step** (SMS can't
send from an email-only trigger) and re-stitches via `dropAction`. First case:
Felicity Worldwide `Xx9sgd` (email welcome flow with 2 SMS steps).
**Re-run:** just re-run on current `main` — the parse now drops the SMS steps.
Flag to the operator that the SMS messages need a dedicated SMS flow.

**General method for any "not a field on schema" error:** open the schema in
redoapp (`codebase_search`, repo `redoapp/redo`, `redo/flows/common/src/schemas/
marketing/marketing.ts`), read its `fields`, and either point the step at the
correct field or — if no valid field exists — drop the step + re-stitch.

## 2. Enum value rejected — `Received "<v>"`
**Cause:** mime's renderer/parser enums drift AHEAD of Redo's accepted schema, so a
value Redo doesn't accept 400s the create.
- **Socials:** `platform: "x"` (X/Twitter) — Redo's `SocialPlatform` has no `x`.
  Fixed in `src/parser/blocks/socials.ts` (`mapPlatformToRedo`: `x→twitter`, drops
  threads/bluesky/twitch/telegram/whatsapp/website/email). Accepted set: apple,
  discord, facebook, github, google, instagram, linkedin, pinterest, reddit,
  snapchat, tiktok, twitter, youtube.
- **`imageSourceType`:** Redo's enum is `{upload, product}` — `"url"` was dropped in
  the CODE-template parser.

**Method:** find the Redo enum in redoapp, then clamp/map the offending value in the
mime block parser (mirror `mapPlatformToRedo` / `mapIconColor`).

## 3. Blank flow email (silent `createEmailTemplate` 400)
**Cause:** the template parses fine but `createEmailTemplate` rejects an enum value;
`importFlowRpc`'s catch swallows it into a blank placeholder, so the bundle shows
`blankTemplateCount` with no reason. Usually class #2 (an enum) on a template.
**Fast repro:** parse the template + call `importTemplateRpc(parsed, {jwt})` with a
live JWT — the exact 400 prints immediately. Then fix as #2.

## Re-run mechanics
- `src/flow/import-one.ts` re-fetches the flow from Klaviyo, re-parses with CURRENT
  code, re-creates templates, and posts `createAdvancedFlow`. `DIAGNOSE_ONLY=1`
  stops before any write and dumps the parsed automation to `/tmp`.
- The importer + the 400-vs-401 handling live in `src/migrate/import-rpc.ts`
  (`importFlowRpc`). A 401 = expired JWT (paste a fresh one); a 400 = schema/enum
  mismatch (this catalog).
- Imported flows land **inactive** in Redo by policy — re-running is safe to review
  before enabling.

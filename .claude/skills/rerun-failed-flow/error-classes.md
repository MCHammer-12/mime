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

**Fix (shipped):** `phoneFieldForSchema()` in `src/flow/parser.ts` picks the
right field, and for `email_marketing_signup` **drops the send_sms step** (SMS can't
send from an email-only trigger) and re-stitches via `dropAction`. First case:
Felicity Worldwide `Xx9sgd` (email welcome flow with 2 SMS steps).
**Re-run:** just re-run on current `main` — the parse now drops the SMS steps.
Flag to the operator that the SMS messages need a dedicated SMS flow.
**Recreate the dropped SMS as a parallel SMS flow** (same messages, timing, and
conditions) with `src/flow/build-sms-variant.ts`:
`KLAVIYO_API_KEY=… REDO_JWT=… FLOW_ID=<id> npx tsx src/flow/build-sms-variant.ts` —
parses forced to `sms_marketing_signup`, drops the email steps + re-stitches, keeps
the SMS + waits + conditions. `DIAGNOSE_ONLY=1` dumps without importing.

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
**Read `blankedTemplates[].reason` in `parse-result.json` first** — since 2026-08-13
the bundle carries the per-email reason, which distinguishes "resolver never got the
HTML" (Klaviyo-side) from "create rejected it" (class #2). Bundles from before that
date only have the count; those need a re-parse with the merchant's Klaviyo key.

## 4. The bundle has no `error.txt` — nothing actually failed
**Cause:** not an error class. `POST /api/jobs/:id/bundle` takes an operator-selected
`{items:[{id,type}]}` list, so a bundle contains whatever the operator ticked, not the
failures. `bundle.ts` writes `error.txt` **only** on the `flow_failed` path — so a
folder with no `error.txt` and a `redoFlowId` in `parse-result.json` imported fine.
**Method:** when every folder is clean, "it didn't work" means fidelity, not failure.
Read back what's in Redo (`rpc/getAdvancedFlowById` + `marketing-rpc/getEmailTemplates`)
and diff against `klaviyo-flow.json`. Check the job's completion time against
`git log` — a Replit-deployed run can predate fixes that are already on `main`.
**Caution:** if the team rebuilt the flow by hand, they edited mime's templates
**in place** (`sections` overwritten, images now `data.getredo.com/redo/Screenshot_*`).
mime never re-hosts images — only `import-rpc.ts` uploads, and only fonts — so a
`getredo.com` image URL is a reliable tell that live Redo no longer shows mime's output.

## 5. Silently dropped Klaviyo field
**Cause:** mime ignores a field it never learned to read, so a merchant-visible
behavior vanishes with no warning. Distinct from a 400: the import "succeeds".
**Detection:** `grep -rn '<klaviyo_field>' src/ --include='*.ts'` against the raw
`klaviyo-flow.json`. No hit = the field is being dropped on the floor.
**Case (fixed):** `message.additional_filters` on a send-email — gates that one
message, not flow entry. Now becomes a CONDITION → send with the false branch past
it (`translateMessageAdditionalFilters`, `src/flow/condition-mapping.ts`). When the
filter can't be translated, no gate is spliced and a requires-review warning names
the consequence. First case: Relay Goods `Y34myV`.

## Re-run mechanics
- `src/flow/import-one.ts` re-fetches the flow from Klaviyo, re-parses with CURRENT
  code, re-creates templates, and posts `createAdvancedFlow`. `DIAGNOSE_ONLY=1`
  stops before any write and dumps the parsed automation to `/tmp`.
- The importer + the 400-vs-401 handling live in `src/migrate/import-rpc.ts`
  (`importFlowRpc`). A 401 = expired JWT (paste a fresh one); a 400 = schema/enum
  mismatch (this catalog).
- Imported flows land **inactive** in Redo by policy — re-running is safe to review
  before enabling.

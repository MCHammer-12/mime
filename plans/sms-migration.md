# SMS migration

Goal: real Klaviyo `send-sms` → real Redo `SendSmsStep` (no WAIT-stub). Currently every Klaviyo SMS step lands as a 0-min WAIT placeholder; merchants have to rebuild SMS by hand.

User flagged 2026-05-05 (Pretty Cult Welcome Flow | SMS) as "a project we need to tackle asap." Research complete; this plan captures the design so the next session can execute.

## Redo's data model (verified)

**SmsTemplate** — single MongoDB doc. Fields we care about:

```ts
{
  _id: ObjectId,                  // omit on create
  team: ObjectId,                 // must == JWT team
  name: string,
  content: string,                // SMS body, Liquid-aware
  prefixContent?: string,         // optional pre-body line
  templateType: "marketing",      // not "transactional" — repo coerces
  category: "Marketing",          // matches advanced-flow categories
  schemaType: SchemaType,         // MUST equal parent flow's schemaType
  autoShortenLinks?: boolean,     // matches Klaviyo's URL shortener
  attachments?: [],               // MMS — drop in v1
  aiConfig?: undefined,           // server attaches automatically
}
```

**Create RPC**: `createSmsTemplate` on `/marketing-rpc`. Same router as `createEmailTemplate`. Permission: `MarketingPermissions.MANAGE_TEMPLATES`. Returns full template with `_id`.

**SendSmsStep** (in advanced-flow steps):

```ts
{
  type: StepType.SEND_SMS,
  id: string,
  templateId: string,             // ObjectId of SmsTemplate
  phoneNumberFieldName: "customerPhone",
  recipientNameFieldName: "customerFirstName",
  nextId?: string,
  disabled?: boolean,
  splitId?: ObjectId,
}
```

Field names are schema-instance keys (camelCase), NOT Liquid variables. Canonical values for marketing flows: `customerPhone`, `customerFirstName`.

**Liquid handling**: same engine + variables as email. `{{ customer_first_name }}` works. Existing `rewriteKlaviyoLiquid` in `src/flow/variable-mapping.ts` translates Klaviyo `{{ person.first_name|default:'Love!' }}` → `{{ customer_first_name|default:'Love!' }}` and applies cleanly to SMS bodies.

**MMS attachments**: `SmsTemplate.attachments[]` supports image attachments, but requires `productSelectionType` + image rehosting. Drop with warning in v1; revisit later.

**Sender identity**: team-level (configured in `merchant/app/src/setting/channel/voice-and-sms`). Nothing to migrate per-template.

## Implementation outline

1. **Fix `SendSmsStep` type in mime** (`src/flow/types.ts:110`)
   - Drop the current bogus `body` field.
   - Add `templateId`, `phoneNumberFieldName`, `recipientNameFieldName`, optional `splitId`.

2. **Add `placeholderSmsTemplates` to ParseResult** (mirroring `placeholderTemplates`)
   - Shape: `{ sentinelId, name, content, schemaType, category, prefixContent?, autoShortenLinks?, klaviyoActionId, smsImageId?, warnings }`
   - `sentinelId` = `new ObjectId().toString()` (matches email pattern).

3. **Replace the WAIT-stub case in parser.ts:266** (`case "send-sms"`)
   - Generate sentinelId.
   - Run `rewriteKlaviyoLiquid(msg.body, warnings, id)` for content.
   - Push to `placeholderSmsTemplates[]`.
   - Honor `msg.smart_sending_enabled === false` (warn → trigger-level `shouldSkipSmartSending`).
   - For `msg.image_id`: warn + drop (v1).
   - Return real `SendSmsStep` with `templateId: sentinelId`, `phoneNumberFieldName: "customerPhone"`, `recipientNameFieldName: "customerFirstName"`, `nextId: terminate(next, state)`.

4. **Importer changes** (`redoapp/redo/manage/src/import-klaviyo-templates.ts`)
   - Loop `bundle.placeholderSmsTemplates`: `postMarketingRpc("createSmsTemplate", { template: { team, name, content, schemaType: bundle.automation.schemaType, category: bundle.automation.category, templateType: "marketing", ...prefixContent, ...autoShortenLinks } })`
   - Map `sentinelId → real _id` in the existing `sentinelToRealId` map.
   - Step-rewrite phase: include `step.type === "send_sms"` in the swap.

5. **Test path**
   - One Klaviyo SMS source → one `_pendingSmsTemplate` → one Redo SmsTemplate created → SendSmsStep references it.
   - Verify `bundle.automation.schemaType` matches what server expects for the chosen trigger (e.g. `email_marketing_signup` for the Pretty Cult Welcome Flow | SMS — but if SMS-trigger lands as `sms_marketing_signup`, the SMS template should use that).
   - Pretty Cult Welcome Flow | SMS has 3 SMS steps with first-name lookup + 10% off code. Good test case.

## Gotchas

- **schemaType match.** SMS template's schemaType must equal parent flow's. Use `bundle.automation.schemaType`, not Klaviyo's per-message metadata.
- **TemplateType auto-coerces.** Send `"marketing"`, not `"transactional"` — repo silently rewrites the latter.
- **`aiConfig` is server-attached.** Send `aiConfig: undefined`. Don't try to forge one.
- **Smart-sending lives on the trigger.** Same as email — only flow-wide.
- **Verify Klaviyo payload shape.** Capture a real `send-sms` action JSON before coding to confirm key names: `msg.body`, `msg.image_id`, `msg.smart_sending_enabled`, `msg.dynamic_link_shortening_enabled`. AI-generated SMS bodies may have a different field shape.
- **`autoShortenLinks` defaults vary.** Klaviyo always shortens. If `msg.dynamic_link_shortening_enabled` (or whatever the actual field is) is true, set `autoShortenLinks: true`; otherwise omit.

## Out of scope for v1

- MMS / image attachments — drop with warning, log image_id for the merchant.
- AI-generated SMS templates (Klaviyo's content-AI feature) — treat as plain text body if `msg.body` is populated; flag for review if the body field is empty.
- Unsubscribe / "Reply STOP" disclaimers — `prefixContent` exists for this; if Klaviyo's source has explicit unsubscribe lines, hoist them.
- SMS A/B tests — `splitId` field exists but Klaviyo's SMS A/B is rare; defer.

## Files

- New / modified in mime:
  - `src/flow/types.ts` — fix `SendSmsStep` type
  - `src/flow/parser.ts:266` — replace skipStub with real SmsStep + placeholder push
  - `src/migrate/import-rpc.ts` — extend bundle shape + RPC loop
  - `src/migrate/server.ts` — pipe `placeholderSmsTemplates` through the export bundle and migration UI
- New in redoapp:
  - `redo/manage/src/import-klaviyo-templates.ts` — extend to call `createSmsTemplate` per placeholder

## Reference (redoapp)

- Schema: `redo/model/src/sms-template.ts`
- Repo: `redo/marketing/db/util/src/sms-template-repo.ts`
- RPC input: `redo/merchant/marketing/rpc/src/schema/sms-template/create-sms-template.ts`
- RPC handler: `redo/merchant/marketing/server/src/handler/sms-template/create-sms-template.ts`
- Step schema: `redo/model/src/advanced-flow/advanced-flow-db-parser.ts:785`
- Canonical step shape (test fixture): `redo/marketing/service/src/tasks/email-flow-interpreter/steps/send-sms.it.spec.ts:140`
- Runtime send path: `redo/marketing/service/src/tasks/email-flow-interpreter/steps/send-sms.ts`

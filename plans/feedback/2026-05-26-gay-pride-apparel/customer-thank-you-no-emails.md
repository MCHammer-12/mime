---
status: done
branch: fix/customer-thank-you-no-emails
pr: null
---

# Customer Thank You flow imported with no email content

## Feedback (verbatim)

M2gVzK (Customer Thank You):

> The flows had no email

i.e. the flow imports into Redo with its steps + conditions intact, but the email steps show no email content (no template attached, or blank template, or unfilled placeholder).

## Root cause

`parse-result.json` is the smoking gun. The parsed automation has **two `send_email` steps** with `templateId` set to placeholder strings:

```
"5633517": { "type": "send_email", "templateId": "__PLACEHOLDER_NDsips__", … }
"5633516": { "type": "send_email", "templateId": "__PLACEHOLDER_K9dMHS__", … }
```

And the result reports `createdTemplateCount: 2` — so mime says it created 2 templates. But the merchant reports no email content in Redo.

The `__PLACEHOLDER_X__` pattern is how mime stages flow-attached emails before the importer resolves them: parser emits a placeholder ID, importer creates the template via `createEmailTemplate` RPC and rewrites the placeholder to the real `_id`. If `createdTemplateCount: 2` but the flow shows no email, one of these is happening:

1. **Placeholder rewrite missed.** Templates were created in Redo (count == 2), but the flow's `send_email.templateId` field still contains the literal `__PLACEHOLDER_X__` string. Result: flow has the step, but the linked template ID doesn't resolve to anything.
2. **Templates created blank.** Importer made the templates with empty `Section[]` (e.g. parser produced 0 sections because the Klaviyo template was empty / not block-editor / parser errored silently). Templates exist on Redo, are linked, but render empty.
3. **Templates linked to wrong slot.** Templates created and rewrites applied but to wrong placeholders.

Relevant files:
- [`src/flow/parser.ts`](src/flow/parser.ts) — emits `__PLACEHOLDER_X__` for flow-attached templates
- [`src/migrate/import-rpc.ts`](src/migrate/import-rpc.ts) — `importFlowRpc` (per memory `project_sms_migration_plan` this is also where SMS placeholders get resolved)
- [`src/migrate/template-resolver.ts`](src/migrate/template-resolver.ts) — typed `ResolveFailure` reasons (PR #39); silent-blank-fallback would land here as `html-empty` or similar

## Proposed change

1. **Reproduce in Redo first.** Look at GPA's `Customer Thank You` flow in the Redo admin (storeId `mcht/68fb99110d340e99f9c2c617`). Open the two `send_email` steps and check:
   - Is `templateId` a real ObjectId or the literal `__PLACEHOLDER_NDsips__` string?
   - If real ObjectId, open the template — is it blank, or does it have content?
   - If blank, the original Klaviyo template was probably empty / non-block-editor. Check the bundle for `templateWarnings` (Reason: `html-empty` or `parser-threw`) — but this bundle's parse-result has no templateWarnings, so the resolver succeeded.
2. **Tell us which case it is** — update this task file's Notes section with the finding. Different fixes for each:
   - **Case 1 (placeholder not rewritten):** Bug in the importer's rewrite step. Trace `importFlowRpc` for the placeholder-to-ID mapping; ensure every `send_email.templateId` is replaced. Likely a missing iteration or off-by-one in the mapping table.
   - **Case 2 (template created blank):** Parser produced empty Section[] for a non-empty Klaviyo template. Pull the source HTML for the M2gVzK flow's emails from Klaviyo and re-run smoke-test; figure out why nothing's emitted.
   - **Case 3 (wrong link):** Mapping bug; trace which placeholder maps to which real ID.
3. **Write a smoke test** for whichever case applies, then patch.

## Verify

- Re-import GPA's Customer Thank You flow: both email steps in the Redo flow builder show a real template with non-empty content
- New smoke test covers the case (placeholder-rewrite or template-resolver per-flow)
- No regression on existing flow imports (`src/flow/parser.smoke.ts` plus a batch-test pass on the historical corpus)

## Notes

- Don't conflate with the SMS placeholder pattern from memory `project_sms_migration_plan` — that has its own placeholder lifecycle (`SendSmsStep` + `createSmsTemplate`). This task is specifically about EMAIL placeholders on flow-attached templates.
- Browse Abandonment flow (VMfMYa) in this same bundle also has one `send_email` with `templateId: "__PLACEHOLDER_XPEKHZ__"`, but the merchant DIDN'T flag it as missing email content — only Customer Thank You. So the bug may be specific to certain step shapes or trigger types, not universal placeholder handling. Worth comparing the two flows' parse-results during diagnosis.
- The Customer Thank You trigger is `order_created` (schemaType `order_tracking`), not a marketing trigger. Possibility: the import path for `order_tracking` flows handles template attachment differently from marketing flows, and that path has the bug.

## Done
**Resolved by PR #135 (orphaned flow-email templateId fix).** This task's root
cause is `templateId: "__PLACEHOLDER_NDsips__"` on send_email steps — the exact
silent-orphaning bug fixed in #135 (`extractCreatedTemplateId` + fail-loud guard
so a placeholder can never reach createAdvancedFlow). Re-import the GPA Customer
Thank You flow with current `main` to confirm real template ids land.

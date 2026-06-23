---
status: unclaimed
branch: fix/flow-email-templateid-orphaned
pr: null
priority: URGENT — breaks all flow email imports
---

# URGENT: flow emails show no content — placeholder templateId never resolved

## Feedback (verbatim)

Jack Henry, Michael (2026-06-23): "all of the emails in this and every other flow aren't showing any content. there is no email. what is happening??" — 5 flows, every email blank in Redo.

## Root cause — mechanism confirmed end-to-end

Templates ARE created in Redo, but the flow's `send_email` steps still point at mime's internal `__PLACEHOLDER_X__` sentinels instead of the real template `_id`s. So emails are orphaned → no content. Silent: no import error.

The chain ([`src/migrate/import-rpc.ts`](../../../src/migrate/import-rpc.ts)):
1. Each template created via `createEmailTemplate`; mime reads the new id as `String(created._id ?? created.id ?? "")` ([line 227](../../../src/migrate/import-rpc.ts)). **If the response has neither `_id` nor `id` at top level → `""`.**
2. `sentinelToRealId.set(ph.sentinelId, "")` ([line 760](../../../src/migrate/import-rpc.ts)) — maps sentinel → empty string.
3. Swap ([lines 843-846](../../../src/migrate/import-rpc.ts)): `const real = sentinelToRealId.get(step.templateId); if (!real) return step;` — **empty string is falsy → silently leaves the `__PLACEHOLDER__` on the step.**
4. `createAdvancedFlow` accepts it: the send_email schema is `templateId: z.string()` (redoapp `advanced-flow-db-parser.ts:796`, "can be an ObjectId OR a special identifier") — **no ObjectId validation, so a placeholder string passes.** Flow imports with zero errors.
5. `createdTemplateCount++` ([line 761](../../../src/migrate/import-rpc.ts)) fires regardless of id capture → the count looks healthy (2 created) even though IDs were empty.

**Why the id is empty (leading hypothesis):** `createEmailTemplate`'s response shape changed on the redoapp side — almost certainly the recent `Move zod (@redotech/zod) → zod-util` refactor (the same era that broke `createSavedEmailTemplate`, fixed in #127). `postMarketingRpc` unwraps `body?.output ?? body` ([line 635](../../../src/migrate/import-rpc.ts)); redoapp `createTemplate` returns `mongoToEntity(doc)`. If the entity now nests the id (e.g. under `.template`/`.data`) or renamed the field, `created._id ?? created.id` is undefined. **Confirm against a live `createEmailTemplate` response before coding.**

## Proposed change

1. **Fix the id capture** (`importTemplateRpc`, ~line 216-227): confirm the current `createEmailTemplate` response shape (live call or redoapp `createTemplate` + RPC serialization) and read the real `_id` from wherever it now lives. This is the actual fix.
2. **Make the swap fail loudly** (lines 843-846): if a `send_email`/`send_sms` step has a sentinel `templateId` but `sentinelToRealId` has no real id (or an empty one), **throw** — do NOT ship a `__PLACEHOLDER__` to `createAdvancedFlow`. A broken flow must fail visibly, not import looking fine. (Silent-wrong is the recurring enemy — same theme as the empty-branch + survey-misresolve work.)
3. **Stop the misleading counter**: only `createdTemplateCount++` when a real id was actually captured; otherwise count it as failed.
4. Consider a guard: assert no step retains a `__PLACEHOLDER_` templateId right before `createAdvancedFlow`.

## Verify

- Re-import Jack Henry: every `send_email` step has a real ObjectId templateId; emails render content in the Redo flow builder.
- Negative test: simulate an empty id from `createEmailTemplate` → import **fails loudly** with a clear error, not a silent blank-email flow.
- Smoke: a synthetic flow with 2 placeholders → both swapped to real ids; assert no `__PLACEHOLDER_` survives in the posted automation.

## Notes

- **Severity: breaks ALL flow email imports for ALL merchants right now** (anything importing flows post-redoapp-change). Likely the same root as the recent `createSavedEmailTemplate` 500 — both are EmailTemplate creation; the response contract shifted. Worth checking with redoapp eng what changed in createEmailTemplate's response.
- Cross-link: GPA Task 1 (`customer-thank-you-no-emails`) was the early, single-flow version of this exact symptom ("createdTemplateCount > 0 but flow shows no email") — this is now the systemic version. That task likely folds into this one.

## Done
(filled by executor)

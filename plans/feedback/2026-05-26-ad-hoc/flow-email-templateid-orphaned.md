---
status: done (diagnosis doc) — #135 MERGED; remaining work = Tasks 9 + 10
branch: fix/flow-email-templateid-orphaned
pr: 135 (merged)
priority: URGENT — Jack Henry flow emails blank
note: This file is the diagnosis + history record. Actionable follow-ups are
  Task 10 (surface-resolve-failure-reason — do first) and Task 9
  (simple-editor-template-parser). #135 is fully merged, not partial.
---

# URGENT: flow emails show no content — Jack Henry

## STATUS 2026-06-25 — what shipped (#135) vs what remains

**#135 shipped + deployed** (`5d66e69 Published your App`). It hardened the
sentinel→real-id **swap** path: empty/unresolved id now **throws** instead of
silently shipping a `__PLACEHOLDER__`; a final guard asserts no step retains a
placeholder; the counter only increments on a real id. **This fixed the GPA
`__PLACEHOLDER_NDsips__` orphaning case** (see #139) and the executor **refuted
the response-shape hypothesis** against live redoapp `origin/main` —
`createEmailTemplate` does return `body.output._id` as a top-level hex string.

**BUT #135 does NOT fix Jack Henry's specific symptom.** Jack Henry's bundle
had `blankTemplateCount: 6` — that is the **`ph.fullTemplate === null` path**
([import-rpc.ts:761](../../../src/migrate/import-rpc.ts)): the template failed
to **resolve at parse time**, so mime built a BLANK, created it as a *real*
template, and the swap mapped the sentinel to that real (empty) id. The swap
succeeds → #135's fail-loud never fires → flow imports pointing at real-but-
blank templates. Different path from the orphaning #135 closed.

**Two items STILL OPEN for Jack Henry:**
1. **Surface the resolve-failure reason** (the meta-fix). The 6 blanks came from
   `fullTemplate === null` and mime logged **no reason** — we still can't tell
   deploy-timing vs Klaviyo api-error vs manifest-miss. `buildBlankTemplate`
   and the parse-time resolver must emit the typed `ResolveFailure` reason per
   blanked template. Until this ships we stay blind on any re-import that still
   blanks. → carved into the resolver/import path; see "TWO actionable items #1".
2. **Handle `editor_type: SIMPLE`** — the 2 plain-`<div>/<span>` templates
   (zero `kl-*` classes) parse to 0 sections. New parser gap, sibling to CODE.
   No SIMPLE path exists in `src/` today (only CODE). → split to its own task
   [`simple-editor-template-parser.md`](simple-editor-template-parser.md).

**Re-import test (now valid — deploy fully live):** re-run Jack Henry. The 6
SYSTEM_DRAGGABLE emails should come through with content **iff** the original
blank was deploy-timing (import hit a half-rolled instance). If they're STILL
blank → it was a resolver fetch error and item #1 is required to see why. The
2 SIMPLE stay blank regardless until item #2 ships.

---

## Feedback (verbatim)

Jack Henry, Michael (2026-06-23 + 2026-06-25): "all of the emails in this and every other flow aren't showing any content. there is no email." Persisted across two re-imports.

## RESOLVED DIAGNOSIS (2026-06-25, with Klaviyo key + Redo JWT)

Fetched all 8 Jack Henry abandoned-cart templates from Klaviyo and ran mime's parser on each. **Two distinct things, both real:**

| Klaviyo id | editor_type | html | mime parse |
|---|---|---|---|
| RqyJ8H, SY7JvT, Y7vBZa, Y4TmNh, Vra2UZ, UYqnU3 | **SYSTEM_DRAGGABLE** | 38–47KB | **13–18 sections (FULL content)** ✓ |
| R2rkiC, Tmf26k | **SIMPLE** | ~2.8KB | **0 sections** ✗ |

1. **The 6 content emails parse perfectly on current mime** (13–18 sections each, with images / interactive-cart / socials / text). They are NOT broken. But the bundle marked them blank (`blankTemplateCount: 6`). So the **deploy produced empties for templates that parse fine locally.** Most likely: the import (19:03 UTC) ran ~3.5 min after a deploy (`c133b02` 18:59 UTC) that hadn't finished rolling out → hit the old instance; OR a resolver `api-error` fetching the 6 large templates. **Can't pin which because the resolver logged no reason** (see #1 below). NOT a fundamental parse problem.

2. **The 2 SIMPLE-editor emails are a genuine parser gap → 0 sections.** `editor_type: SIMPLE` templates are plain `<div>/<span>` (R2rkiC has **zero `kl-*` classes** — "Hi {{ first_name }}, Noticed you left a few things behind…"). mime's parser keys entirely on `kl-*` block classes, so SIMPLE templates produce nothing. This is a NEW unsupported-editor-type gap, sibling to CODE. **These are blank no matter what.**

**Immediate test for Michael:** re-run the Jack Henry import NOW (deploy is fully live hours later). The 6 SYSTEM_DRAGGABLE emails should come through with content. The 2 SIMPLE ones will still be blank (need the parser gap fixed). If the 6 are STILL blank on a fresh import → it's a deploy-side resolver fetch/runtime issue, and fix #1 will reveal the reason.

**Three fixes (see "TWO actionable items" + this):**
- (#1) Surface the `ResolveFailure` reason per blanked template (the meta-fix — would have shown api-error vs propagation in one bundle).
- (#2) Stop the blank-fallback swallowing the create error.
- (#3 NEW) **Handle `editor_type: SIMPLE`** — a plain-HTML parser path (no kl-classes), like the CODE path. Fixes the 2.

---
## (nuance — read with the STATUS block above) swap-orphaning was REAL but is NOT Jack Henry's path

Update 2026-06-25: the swap-orphaning **mechanism** below turned out to be real
(GPA had a literal `__PLACEHOLDER_NDsips__`) and #135 fixed it. What was
*disproven* is (a) the **response-shape** hypothesis (`createEmailTemplate`
returns a top-level `_id` fine) and (b) that this is **Jack Henry's** symptom —
his 6 blanks are the `fullTemplate === null` resolve path, not the swap. The
live-Arvo inspection below still stands as proof the swap works when ids resolve.

Live inspection via the Redo MCP of a real mime-imported flow ("Added To Cart (Arvo)", `6a26e00499ad61dbf054c05a`, imported 2026-06-08) shows the importer **works end-to-end**:
- every `send_email` step carries a **real ObjectId templateId** (e.g. `6a26e002090fd8338876f05b`), NOT a placeholder — the swap works;
- `get_template` on that id returns a **fully populated** template (images, columns, button, socials, footer).

So the placeholder-swap / empty-`_id` mechanism described in the "Root cause" section below is **not** what's happening. Disregard it.

**What's actually wrong (from the 2026-06-25 bundle, flow SRiAES "WC | Abandoned Cart"):**
- `createdTemplateCount: 2, blankTemplateCount: 6` (8 email steps). manifest `emailsImported: 8`.
- Per [import-rpc.ts:756-762](../../../src/migrate/import-rpc.ts), `blankTemplateCount++` fires when **`ph.fullTemplate` is null** — i.e. the template **failed to resolve at parse time**, so mime built a BLANK. So **6 of 8 templates never resolved → blank → no content.** 2 resolved fine.
- **The resolver recorded NO reason** — the bundle has zero `templateWarnings`. The typed `ResolveFailure` reasons (PR #39) are not surfacing. We've been blind across two rounds because of this.

The 8 Klaviyo template ids (resolve targets): `RqyJ8H, SY7JvT, Y7vBZa, Y4TmNh, Vra2UZ, R2rkiC, UYqnU3, Tmf26k`.

**Leading hypothesis (needs confirmation, same method that cracked Castle Sports):** the 6 failing templates are `editor_type: CODE` → the CODE parser returns empty → null fullTemplate → blank. Could also be Klaviyo API errors fetching them. **Cannot confirm without Jack Henry's Klaviyo key** (to check `editor_type` on those 8 ids + re-parse) OR the Redo MCP pointed at Jack Henry's team (to inspect flow `6a3d7b703ea1aa15b600bbdf` + its templates live — the MCP is currently authed to a different team, "Arvo/Otishi").

**Open discrepancy:** Michael reports "every flow, every email" blank, but the first bundle had flows with `blankTemplateCount: 0` (content created). If content templates ALSO render blank in Redo, there may be a SECOND issue (a regression after 2026-06-08, since Arvo imported then works). Needs live Jack Henry data to confirm.

## TWO actionable items regardless of the above

1. **Surface the resolve-failure reason (do this first — it's why we're blind).** The resolver/import path must emit a `templateWarning` with the typed `ResolveFailure` reason for EVERY template that falls to blank (`ph.fullTemplate === null`). Today it's silent. With it, the next bundle tells us exactly why each of the 6 went blank instead of guessing. Files: [`src/flow/template-resolver.ts`](../../../src/flow/template-resolver.ts), the resolve call in the flow parser, [`import-rpc.ts:756`](../../../src/migrate/import-rpc.ts).
2. **Don't swallow the content-create error in the blank fallback** ([import-rpc.ts:769-786](../../../src/migrate/import-rpc.ts)): if `importTemplateRpc` throws for a content template, the catch builds a blank and discards the original error `e` (only re-thrown if the blank ALSO fails). Log/emit `e` so a createEmailTemplate failure is visible, not masked as a silent blank.

## NEXT STEP TO LOCALIZE (needs Michael)
Provide ONE of: (a) Jack Henry's Klaviyo private key → check `editor_type` of the 8 template ids + re-parse the failing ones (confirms CODE vs API-error); (b) the Redo MCP scoped to Jack Henry's team → inspect flow `6a3d7b703ea1aa15b600bbdf` and whether its 2 "content" templates actually render. Either localizes it in minutes.

---
## (DISPROVEN — kept for history) Original root cause hypothesis

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

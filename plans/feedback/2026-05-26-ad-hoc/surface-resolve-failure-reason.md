---
status: unclaimed
branch: fix/surface-resolve-failure-reason
pr: null
priority: high — we're blind on every blanked flow email
---

# Surface the resolve-failure reason for every blanked flow email

## Origin
Split from [`flow-email-templateid-orphaned.md`](flow-email-templateid-orphaned.md)
(Jack Henry deep-dive, 2026-06-25). #135 made the sentinel→id **swap** fail
loud — but Jack Henry's symptom is upstream of the swap: 6 of 8 templates had
`fullTemplate === null` (failed to **resolve at parse time**), so mime built
*real but blank* templates and imported them silently. We still cannot tell
WHY they blanked: deploy-timing vs Klaviyo api-error vs manifest-miss. The
bundle carried **zero** `templateWarnings`.

## Root cause of the blindness
When a template fails to resolve, the typed `ResolveFailure` reason (PR #39 —
`manifest-miss-no-api-key`, `manifest-miss-and-api-miss`, `api-error`,
`disk-html-missing`, `html-empty`, `parser-threw`) is computed but **not
propagated** to the flow-import result. The blank path
([import-rpc.ts:761](../../../src/migrate/import-rpc.ts), `buildBlankTemplate`)
records nothing. So `blankTemplateCount: 6` arrives with no per-template reason.

## Proposed change
1. **Carry the reason through.** The placeholder type already has
   `templateWarnings: string[]` ([import-rpc.ts:689](../../../src/migrate/import-rpc.ts)).
   When the parse-time resolver returns null/failure, attach the typed
   `ResolveFailure.reason` (+ Klaviyo template id) to that placeholder.
2. **Emit it on blank.** In the `ph.fullTemplate === null` branch, push a
   `template_blanked` progress event / warning naming the template id + the
   reason, instead of silently incrementing `blankTemplateCount`.
3. **Roll it into the import summary** so a bundle/manifest shows, per blanked
   email, exactly why (api-error vs manifest-miss vs html-empty). This is what
   turns the next "emails are blank" report from a 3-round guessing game into a
   one-look diagnosis.

Files: [`src/flow/template-resolver.ts`](../../../src/flow/template-resolver.ts),
the resolve call in [`src/flow/parser.ts`](../../../src/flow/parser.ts),
[`src/migrate/import-rpc.ts`](../../../src/migrate/import-rpc.ts) (~745-790,
the placeholder build + blank branch + the returned summary).

## Verify
- Re-run Jack Henry (or a fixture with a deliberately unresolvable template):
  the import result lists each blanked email with its typed reason.
- A template that resolves fine emits no blank warning (no false positives).
- Unit: a placeholder with a forced `ResolveFailure` → reason appears in the
  summary; `blankTemplateCount` still accurate.

## Notes
- Do this FIRST among the Jack Henry follow-ups — it's the meta-fix. Without it,
  if the re-import still blanks the 6 SYSTEM_DRAGGABLE templates, we're blind
  again. With it, the next bundle says exactly why.
- Pairs with Task 9 (`simple-editor-template-parser`): SIMPLE templates that
  yield 0 sections should also surface a clear reason here rather than a bare
  blank.

## Done
(filled by executor)

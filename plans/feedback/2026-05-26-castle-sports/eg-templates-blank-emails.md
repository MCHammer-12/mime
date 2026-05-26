---
status: unclaimed
branch: fix/eg-templates-blank-emails
pr: null
---

# `[EG]` templates produce blank emails across 3 flows

## Feedback (verbatim)

Castle Sports flagged 3 flows:

- WrazNX `[EG] Browse Abandonment Flow`: "Non of the Emails had images"
- Xm2TP7 `[EG] Checkout Abandonment Flow`: "Non of the Emails had images"
- R9iyHp `[EG] Checkout Abandonment Flow [No Discount Code]`: "Non of emails had images"

## Root cause

Merchant says "no images" but the parse-result reveals **the entire email is blank**:

- WrazNX: `blankTemplateCount: 2`
- Xm2TP7: `createdTemplateCount: 0, blankTemplateCount: 5`
- R9iyHp: not yet sampled — assume similar

The importer counts a template as `blank` when parsing produces an empty `Section[]`. The flow shell migrated (trigger + conditions + wait steps + send-email step pointers), but every email's content came out as zero sections.

The `[EG]` prefix on the flow names is the strongest signal — these templates likely came from a Klaviyo template-pack (possibly "Email Generator" / "EG", or a third-party marketplace template, or merchant's own theme). The template HTML uses a structure mime's parser doesn't recognize, so it falls through to no-block-emitted.

Compare with `[EG] Post Purchase Flow` (UQJH6z) which uses the same `[EG]` prefix BUT has `createdTemplateCount: 3, blankTemplateCount: 0` — content was extracted. So either:
1. `[EG]` is just a naming convention and the abandonment templates happen to use different markup
2. Only the abandonment-shaped `[EG]` templates fail (cart-context blocks the parser doesn't handle)

Relevant files (likely culprits):
- [`src/parser/index.ts`](src/parser/index.ts) — dispatcher; if no kl-* class is recognized, may produce empty output silently
- [`src/parser/code-template.ts`](src/parser/code-template.ts) — CODE-template parser (paused per memory `project_code_template_parser`). The `[EG]` templates may be `editor_type: CODE` templates that hit the CODE detection but fall through because CODE is gated off
- [`src/parser/blocks/klaviyo-specific.ts`](src/parser/blocks/klaviyo-specific.ts) — Klaviyo-specific block routing
- [`src/migrate/template-resolver.ts`](src/migrate/template-resolver.ts) — resolver failure modes; check if `html-empty` or `parser-threw` fired (they would show in `templateWarnings`)

## Proposed change

1. **Pull source HTML for one `[EG]` template.** Use the bundled flow JSON to find the actual Klaviyo template IDs behind the `__PLACEHOLDER_X__` strings in the parse-result. Pull the HTML via `/api/debug/resolve-template` or Klaviyo API (Michael will need to provide a key for Castle Sports).
2. **Identify the template's `editor_type`.** Klaviyo distinguishes:
   - `editor_type: PARENT_AND_CHILD` or `DRAG_DROP` → block-editor templates, handled by mime's main parser
   - `editor_type: CODE` → inline-styled HTML, currently gated off (see CODE parser memory)
   - `editor_type: HTML` → raw HTML, unsupported  
   If `[EG]` templates are CODE or HTML, the parser correctly returns empty. The bug is then: the operator should be warned that this template family won't migrate, not have it silently blank.
3. **If block-editor**: identify the specific block pattern the parser is missing. Add support.
4. **If CODE / HTML**: surface a clear preflight warning ("This template uses a non-block-editor format — content won't migrate. Skip or convert manually first."). Mark the flow's emails with `templateWarnings` carrying a specific reason like `unsupported-editor-type`.
5. **Update [`src/migrate/template-resolver.ts`](src/migrate/template-resolver.ts)** with a new `ResolveFailure` variant if a new reason is needed (e.g. `unsupported-editor-type`).
6. **Smoke test.** Synthetic `[EG]`-shaped template → expected output (either parsed sections OR a clear warning, not silent blank).

## Verify

- One of the 3 affected flows reproduces locally with smoke-test on the source HTML
- Either the parser produces non-empty Section[] (if block-editor fix), OR the resolver returns a typed failure with a clear reason (if CODE / HTML)
- Re-import Castle Sports: either the emails have content, OR the operator gets a preflight modal explaining what's missing
- No regression on the historical corpus

## Notes

- **Talk to Michael before the fix lands** — if `[EG]` is CODE/HTML, the fix is operator-facing UX (preflight warning). The parser-pause memory for CODE templates says "first-pass parser landed, visual fidelity insufficient, inert behind editor_type gate". This task may want to revisit whether to ship the CODE parser even with imperfect fidelity, vs. just warning.
- Don't conflate with GPA Task 1 (`customer-thank-you-no-emails`). GPA's flow has `blankTemplateCount: 0` (placeholder rewrite/template-link issue) — different surface from Castle's `blankTemplateCount: 2-5` (parser produced empty Section[]).
- The 4th `[EG]` flow (`Post Purchase`, UQJH6z) is NOT in this task — it parses to content. Tasks 2 + 3 cover that flow's separate issues.

## Done

(filled by executor on completion)

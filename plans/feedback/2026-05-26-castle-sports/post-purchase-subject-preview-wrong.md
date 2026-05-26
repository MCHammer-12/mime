---
status: done
branch: fix/post-purchase-subject-preview-wrong
pr: https://github.com/MCHammer-12/mime/pull/89
---

# Post Purchase Email 1: subject line + preview text wrong

## Feedback (verbatim)

Castle Sports `[EG] Post Purchase Flow` (UQJH6z), Email 1:

> Email 1. Both the subject line and the preview text were incorrect.

## Root cause

Templates created with the WRONG subject line and preview text. Two possibilities:

1. **Wrong source field.** Klaviyo templates carry both a `subject_line` (used in the template's metadata) and per-action overrides (`send_email_action.data.subject`). mime might be pulling from one when the other is canonical. The action-level subject usually wins at send time in Klaviyo.
2. **Substitution applied to wrong target.** mime applies organization.name / first_name substitutions to subject + preview (per PR #44 / PR #29 era work — `substitutions` array in parse-result). If Email 1's source had templated tokens like `{{ first_name }}, your order is on the way!` and mime substituted wrong values OR substituted the literal Klaviyo source instead of the action-level override.
3. **Inheritance bug.** Email 1 may inherit subject/preview from another email in the flow due to a bug in the per-email iteration.

Relevant files:
- [`src/flow/parser.ts`](src/flow/parser.ts) — emits per-step send_email config
- [`src/migrate/import-rpc.ts`](src/migrate/import-rpc.ts) — `importFlowRpc` populates the template's subject + preview when creating via `createEmailTemplate`
- [`src/parse-template.ts`](src/parse-template.ts) — template-level subject/preview extraction
- [`src/export-template.ts`](src/export-template.ts) — full EmailTemplate JSON exporter

## Proposed change

1. **Compare Klaviyo source vs. what landed in Redo.** Pull Email 1's source from Klaviyo (need API key for Castle). Find:
   - Klaviyo template's `subject_line` field
   - Klaviyo `send_email_action.data.subject` (per-action subject override)
   - Klaviyo `send_email_action.data.preview` (preview text)
2. **Inspect Castle's Redo template** for Email 1 of the Post Purchase flow. Note the subject + preview that landed.
3. **Identify the mismatch.** Three cases described above. Pick the right fix:
   - **Source-field bug**: use the action-level override when present (with template metadata as fallback)
   - **Substitution bug**: trace and fix the substitution application
   - **Inheritance bug**: trace the iteration over flow steps
4. Add a smoke test asserting subject + preview round-trip correctly for a multi-step send_email flow.

## Verify

- Re-import Castle's Post Purchase flow: Email 1 subject + preview match Klaviyo's source
- Email 2 + 3 still have their correct subjects (regression check)
- Smoke test passes
- Other Order Tracking flows in historical corpus don't regress on subject/preview

## Notes

- Tasks 2 and 3 (Post Purchase content issues) might share root cause. Worth coordinating if running in parallel.
- The Post Purchase flow has `createdTemplateCount: 3` (vs. 0 for the blank flows in Task 1) — so emails DO have content, just wrong content for Email 1's headers. This is a metadata issue, not a parsing issue.
- The trigger for this flow is `order_created` (schemaType `order_tracking`). If the bug is specific to `order_tracking` schemaType inheritance (per PR #61), it could affect any Order Tracking flow — verify on at least one other Order Tracking flow.

## Done

- PR: https://github.com/MCHammer-12/mime/pull/89
- **Root cause: regex mismatch on Liquid filters.**
  [`substituteStringVars`](../../../src/transform.ts) (used on subject +
  preview) walked `Object.entries(TEXT_VAR_MAP)` building a regex
  `\{\{\s*first_name\s*\}\}` per variable. That shape doesn't match
  `{{ first_name|default:'' }}` (Castle's actual subject line for Email 1
  in flow UQJH6z). The body-HTML path
  ([`mapProfileVars`](../../../src/transform.ts)) had a different,
  filter-tolerant regex `\{\{\s*(<name>)\s*(\|[^}]*)?\}\}` that
  preserves filters during rewriting — body text rendered fine, only
  subject/preview shipped the raw Klaviyo token.
- Confirmed Klaviyo source for the 3 Post Purchase emails by fetching
  the flow definition via API:
  - Email 1 (RUpF6R): `subject_line: "Thank you {{ first_name|default:'' }} :)"`, preview `"Welcome to the family!"`
  - Email 2 (SqEd95): `subject_line: "Let the games begin ;)"`, preview `">>>"`
  - Email 3 (Ugb6QN): `subject_line: "Wow, thank you again, {{ first_name|default:'' }},"`, preview `"We couldn't have done it without you"`
- Fix shape:
  1. Switched `substituteStringVars` customer-profile substitution to the
     same filter-tolerant regex `mapProfileVars` uses. Var rewrites to
     its Redo equivalent (`first_name` → `customer_first_name`); filter
     preserved verbatim.
  2. In [`src/flow/parser.ts`](../../../src/flow/parser.ts), ran
     `substituteStringVars` on the action-level subject + preview
     **before** placing them on the `placeholderTemplate`. The
     importer prefers `ph.subject || ph.fullTemplate.subject` at
     [`import-rpc.ts:720`](../../../src/migrate/import-rpc.ts), so
     without substitution at the placeholder level the raw Klaviyo
     variable was what landed in Redo.
- Verification:
  - End-to-end on UQJH6z: Email 1's emitted subject is now
    `"Thank you {{ customer_first_name |default:'' }} :)"` (was the
    literal Klaviyo source).
  - [`src/transform.smoke.ts`](../../../src/transform.smoke.ts) pins
    9 cases (bare / filter / different filters / dotted-path / unknown
    var / unknown var w/ filter / org.name regression / shop.name
    regression / mixed).
  - `parser.smoke.ts` still passes; batch-test 416 templates: 0
    failures, identical clean/warned counts.
- **Not in scope (already covered elsewhere):**
  - Body-text variables with filters (`mapProfileVars` already handles
    them; existing behavior).
  - Cross-merchant font issues — separate Charlie-Task-4-family.

## Done

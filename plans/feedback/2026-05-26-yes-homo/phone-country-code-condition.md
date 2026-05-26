---
status: unclaimed
branch: fix/phone-country-code-condition
pr: null
---

# Klaviyo phone-country-code profile-property condition not mapped

## Feedback (verbatim)

Yes Homo `SMS Welcome Series Customer vs Non-Customer` (XpzmZx):

> The second conditioner split was incorrect ($Phone_number{operator} US, and CA}
> The wrong conditions were used or not completed.

i.e. the flow has two conditional splits:
1. First split: customer_activity (placed an order at least once — "Customer vs Non-Customer") — migrated correctly
2. Second split: profile property `$phone_number` with operator `phone-country-code-in ["US","CA"]` — **incomplete / wrong in Redo**

The merchant correctly identified that the country-code split is the broken one.

## Root cause

Parse-result confirms the bug. `flow-XpzmZx/parse-result.json` warning:

```
"profile-property condition (phone_number phone-country-code-in 'US,CA') — manual config required; Redo custom-property conditions need team-level segment, not inline"
```

So mime detected the Klaviyo profile-property condition with the `phone-country-code-in` operator but couldn't map it to Redo because:
- Klaviyo allows inline profile-property conditions in a flow's conditional-split node
- Redo's conditional-split only supports certain inline condition types (customer_activity, customer_attribute boolean dimensions per memory `feedback_skipped_action_mappings`). Profile-property comparisons aren't one of them — they need a team-level Redo segment to wrap the property check, then the conditional-split references the segment.

mime emits the warning and likely leaves the condition node with an empty expression — that's why the merchant says "wrong conditions were used or not completed". The flow imports but the second split has no effective predicate, so traffic falls through to one branch.

Relevant files:
- [`src/flow/condition-mapping.ts`](src/flow/condition-mapping.ts) — Klaviyo condition → Redo condition translation (handles `profile-marketing-consent` per memory `feedback_flow_status_mapping`)
- [`src/flow/parser.ts`](src/flow/parser.ts) — flow parser; calls condition-mapping
- [`src/migrate/import-rpc.ts`](src/migrate/import-rpc.ts) — importFlowRpc; if a team-level segment needs creating, that happens here

## Proposed change — needs Michael's input on policy

Two routes, depending on how Redo wants to handle Klaviyo profile-property conditions:

**Option A: Auto-create a Redo team-level segment + reference it.**
- mime detects the profile-property condition
- Builds a Redo segment definition (e.g. "Phone country code in US or CA")
- Creates the segment via Redo API at import time
- Conditional-split now references the segment ID
- Pro: fully automated migration, merchant sees a working split
- Con: requires implementing segment creation in `import-rpc.ts`; may need new Redo API endpoint; team-level pollution if multiple flows have similar conditions (segment proliferation)

**Option B: Emit a clear placeholder + operator guidance.**
- mime leaves the condition node with a `PLACEHOLDER` predicate that always evaluates true (or false — pick safer default)
- Surfaces a `requires-action` warning in the import UI: "Phone country code split detected — create a Redo segment for [US,CA] and link it to this split manually before enabling"
- Pro: low implementation cost; honest about what couldn't migrate
- Con: merchant has to do manual work; flow is broken until they do

**Option C: Map to a Redo dimension if one exists.**
- Check if Redo has a `phone-country-code` customer_attribute dimension out of the box
- If yes, map directly (cleanest)
- If no, fall back to A or B

**Per memory `feedback_skipped_action_mappings`:** "emit WAIT stubs for un-translatable Klaviyo actions; don't speculatively map to Redo until Michael provides per-action rules". That memory is for actions; conditions may follow the same policy. Worth confirming with Michael.

## Executor steps (once Michael picks)

For Option C (check first):
1. Look up Redo's customer_attribute dimensions in redoapp schema. If `phone-country-code` or similar exists, map directly.

For Option A (if implementing):
1. Add segment-creation logic to `import-rpc.ts` that takes the parsed condition + creates a segment
2. Patch `condition-mapping.ts` to emit a `referenced-segment` condition type with the new segment ID
3. Smoke test with synthetic phone-country split

For Option B (lightest):
1. In `condition-mapping.ts`, emit a placeholder condition (e.g. evaluates `true` so traffic continues — safer than dropping the flow)
2. Surface a `requires-action` warning in the import bundle with explicit instructions
3. Update preflight modal copy to surface this kind of warning prominently

## Verify

- Yes Homo SMS Welcome re-imported: second split works as expected (Option A/C) OR has clear remediation steps in the merchant's UI (Option B)
- New smoke test in `condition-mapping.smoke.ts` covering the phone-country-code-in operator
- Regression: customer_activity + customer_attribute condition splits still work

## Notes

- This is a profile-property pattern that probably extends beyond phone country codes. Other operators like `equals`, `contains`, `is-set`, `is-in-set` on profile properties (Klaviyo has many) may share the same root cause. Scope this task to phone-country-code only for now; if Michael wants broader coverage, that's a separate scoping conversation.
- SMS specifically may use different condition handling than email flows. The flow type here is `email_marketing_signup` (per the trigger key) but using SMS sends. Worth confirming the condition node isn't routed differently for SMS vs email.
- Don't conflate with Charlie Task 8 (flow profile filters). That's about **flow-entry profile filters** (filter the whole audience). This is about **mid-flow conditional splits** that branch on profile properties. Different surface, may share code paths.

## Done

(filled by executor on completion)

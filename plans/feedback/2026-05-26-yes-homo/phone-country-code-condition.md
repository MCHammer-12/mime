---
status: done
branch: fix/phone-country-code-condition
pr: https://github.com/MCHammer-12/mime/pull/93
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

- PR: https://github.com/MCHammer-12/mime/pull/93
- **Resolved as Option C (direct map to native Redo dimension) — not B.**
  The planner flagged this as "needs team-level segment" but that premise
  was wrong: Redo has a native `country` customer-attribute dimension.
  Confirmed by reading the checked-out redoapp source (not docs):
  - `CustomerCharacteristicType.COUNTRY = "country"` in
    `redo/model/src/marketing/segments/segment-types.ts`
  - SQL path `location_country_code` → ISO-2 code values
  - `TokenCompareOperators` = `ANY` / `NONE`
  - whereCondition `type: "token"` (no prerequisite, unlike state/city)
    per `segment-characteristic-condition.tsx`
  - Exact JSON matches redoapp's own `evaluate-segment-membership.it.spec.ts`
    country test
  - Also cross-checked a live Redo "Texas" segment via the Redo MCP
    (`get_segment`) which showed the sibling `state-province` /
    `phone-number-area-code` token shapes.
- Mapping (in [`condition-mapping.ts`](../../../src/flow/condition-mapping.ts)):
  - `phone-country-code-in` → operator `ANY`; `-not-in` → `NONE`
  - value normalized from array OR comma-string → uppercased ISO-2
  - non-phone profile-property conditions still fall back to the existing
    manual-config placeholder (unchanged)
- Emits a `degraded-mapping` warning: Klaviyo keys on the phone number's
  country code, Redo's `country` is the customer's profile country. They
  align for SMS audiences and it's exactly what the operator built by
  hand in Redo (per screenshot). Redo has no phone-country-code
  dimension, so profile country is the right native target.
- Verification: 5 new `condition-mapping.smoke.ts` cases pass; existing
  flow smoke tests pass; batch-test 416 templates 0 failures.
- **Pending (per shipping decision):** live re-parse of the real XpzmZx
  flow + re-import to confirm the split renders in the Redo flow builder.
  Synthetic shape matches redoapp's own test, so confidence is high.
- **Scope note for future work:** this covers phone-country-code only.
  Other Klaviyo profile-property operators (`equals`, `contains`,
  `is-set` on arbitrary properties) still hit the manual-config
  placeholder — a separate scoping conversation if merchants flag them.

## Done

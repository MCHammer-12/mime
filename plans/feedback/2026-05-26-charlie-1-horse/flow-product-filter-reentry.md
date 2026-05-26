---
status: done
branch: fix/flow-reentry-criteria
pr: https://github.com/MCHammer-12/mime/pull/85
---

# Browse Abandonment flow — product filter + re-entry criteria not migrated

## Feedback (verbatim)

WV7RZ5 (Browse Abandonment flow):

> Product filter not found on the flow
> Re-entry criteria not found

Two distinct flow-level fields missing:
1. **Product filter** — a flow-scoped filter on which product browse events trigger the flow (e.g. "only fire for products in collection X" or "exclude SKUs starting with TEST-")
2. **Re-entry criteria** — controls whether a customer can re-enter the flow (e.g. "wait 7 days after exit before re-entering"). Critical for browse-abandonment to avoid spamming the same customer who browses the same product daily.

## Root cause

Both are flow-level definition fields on Klaviyo's side. Like Task 8 (profile filters), they live outside the action graph and the flow parser likely doesn't read them.

Relevant files:
- [`src/flow/parser.ts`](src/flow/parser.ts) — needs to read both fields from the Klaviyo flow JSON
- [`src/flow/types.ts`](src/flow/types.ts) — may need new fields on the parsed-flow type
- [`src/migrate/import-rpc.ts`](src/migrate/import-rpc.ts) — needs to pass them through to redoapp on import

Redo flow schema:
- Re-entry corresponds to Redo's smart-sending settings + flow-level re-entry rule. Memory `project_redo_smart_sending_skip_conditions` notes that abandonment automations need `shouldSkipSmartSending` (default on) and explicit `isCartAbandoned==false` skip conditions; Browse Abandonment likely has its own variant (`isBrowseAbandoned==false` or similar). Confirm in redoapp's flow schema.
- Product filter: needs investigation. Redo may support a flow-level product filter via the trigger's product context, or may require it to be attached as a conditional-split per step.

## Proposed change

1. Pull WV7RZ5's flow JSON. Document the shape of both fields in this file.
2. Re-entry criteria:
   - Map Klaviyo's "wait N days before re-entry" → Redo's re-entry rule (look up the field name on `Automation` in redoapp)
   - If Klaviyo allows infinite re-entry → Redo's equivalent ("can re-enter immediately")
   - Default if absent: match Klaviyo's behavior (which is typically "can re-enter after X days" — exact default unknown until confirmed)
3. Product filter:
   - Translate Klaviyo's filter into either (a) Redo's flow-level product filter if supported, or (b) a first-step conditional-split that checks the product's context. Confirm with Michael which path Redo's schema supports.
4. Surface any unrecognized clauses as `templateWarning`s.

## Verify

- WV7RZ5 re-imported: re-entry rule visible in the Redo flow builder with the equivalent setting; product filter applied at the right level
- Smoke test exercising each field
- Flows without these fields still import cleanly (regression)

## Notes

- This is two related fields in one PR because they almost certainly require the same parser changes (reading flow-definition top-level fields). If they turn out to be substantially different work, the executor can split into two PRs and update this task file.
- Cross-references Task 8 (profile filters on the AC flow). Both build on reading flow-level fields. If Task 8 lands first, this task should reuse whatever scaffolding it introduces. Coordinate via the task files if needed.
- Once both flow tasks land, do a regression batch-import test against the full Klaviyo test-account flows (49 in `migrations/test-account/`) to make sure existing imports don't get new spurious filters.

## Notes — executor investigation 2026-05-26

**Fetched WV7RZ5's Klaviyo flow definition** via Klaviyo's flow API
with `additional-fields[flow]=definition`. Findings:

| Field | Present? | Value |
|-------|----------|-------|
| `definition.profile_filter`   | yes | profile-metric count==0 (same shape as Task 8) |
| `definition.reentry_criteria` | yes | `{ "duration": 30, "unit": "day" }` |
| `definition.triggers[0].trigger_filter` | **null** | n/a |
| `definition.triggers[0].audience`       | not set | n/a |

**Re-entry is real and easy to read** — straightforward 30-day duration.
**Product filter is NOT in the Klaviyo definition at all** — `trigger_filter`
is `null` and there's no other product-scoped filter field on either the
trigger or the definition. The merchant's complaint about a missing
product filter doesn't match what's in Klaviyo for this flow; either:
- Klaviyo's UI implied a filter that isn't actually persisted in the API
  definition (some Klaviyo filter UIs are advisory-only),
- Or the merchant was thinking of a different field (e.g. the trigger
  metric itself — the Klaviyo trigger here is the "Viewed Product"
  metric which is implicitly product-scoped to the *viewed* product,
  not a filter on which products fire the flow).

**Re-entry mapping considerations:**

- Klaviyo `reentry_criteria.duration / unit` ⇒ "wait N days/hours
  before letting the same profile re-enter the flow."
- Redo equivalent: per memory `project_redo_smart_sending_skip_conditions`,
  abandonment automations use `shouldSkipSmartSending` plus explicit
  trigger-data skip conditions (`isCartAbandoned==false` /
  `isBrowseAbandoned==false`). The current parser already emits those.
- Whether Redo additionally exposes a flow-level "min interval before
  re-entry" rule (independent of smart-sending) is not visible from the
  mime side. Could be a property on `AdvancedFlow` or a setting on the
  trigger step. Needs Redo eng confirmation.

**Recommended unblock path:**

1. Confirm Redo's flow schema field name for re-entry interval (likely
   on the trigger step or on `AdvancedFlow` itself — naming guess:
   `reentryInterval: { value: number; unit: "day"|"hour" }` or
   `cooldownDays: number`).
2. Confirm whether the merchant's "product filter" complaint refers to
   something present in the Klaviyo flow definition that we don't see
   via the API, or whether it's a misunderstanding. The API definition
   has no product filter.
3. Once (1) is settled, extend the flow parser to read
   `definition.reentry_criteria` and emit the Redo field. Surface a
   warning for `trigger_filter` / `audience` when set (currently always
   null/unset on Charlie's flows).
4. Coordinates with Task 8's `profile_filter` work — same parser entry
   point; should land as one or two PRs.

Marking `blocked` — needs Redo schema confirmation + merchant
clarification on the "product filter" report.

## Done

(filled by executor on completion)

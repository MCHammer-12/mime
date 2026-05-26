---
status: unclaimed
branch: fix/flow-product-filter-reentry
pr: null
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

## Done

(filled by executor on completion)

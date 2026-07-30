---
name: rerun-failed-flow
description: Re-run a Klaviyo→Redo flow import that failed during creation, diagnosing and fixing the schema/enum mismatch that broke it. Use when a flow import failed, a troubleshoot bundle shows a flow error, or the user says "re-run the failed flow", "retry the flow creation", "this flow failed to import", "flow creation failed missing a schema field", or drops a troubleshoot-*.zip for a flow.
---

# Re-run a failed flow creation

A flow import fails when a Redo RPC rejects the payload — almost always a
**schema-field or enum mismatch** in the parsed flow/template, surfaced as a
`createAdvancedFlow` / `createEmailTemplate` **400**. Re-running = find the root
cause from the error, fix it (prefer the parser so every such flow is fixed),
then re-import. Run everything from the mime repo root.

## 1. Get the failure context
From a troubleshoot bundle (dashboard "Download bundle") or a job id:
- [ ] Unzip it. Read `manifest.json` → `storeId`, `jobId`, and the failed flow's
      Klaviyo id (the `flow-<id>/` folder, e.g. `flow-Xx9sgd`).
- [ ] Read `flow-<id>/error.txt` — the exact RPC error. **This is the whole game.**
- [ ] `flow-<id>/klaviyo-flow.json` = the raw flow (re-parseable). `parse-result.json`
      = what the OLD deploy produced (compare against a fresh parse).

## 2. Classify the error (see `error-classes.md`)
Read `error-classes.md` and match `error.txt`. The common shapes:
- **`… references "<f>", which is not a field on schema "<X>"`** — a step points at
  a field the trigger schema doesn't have (the flagship case: SMS phone field in
  an email-only signup flow). → look up schema X's real fields, use the right one
  or drop the step.
- **`Received "<v>"` / enum error** — a value outside a Redo enum (e.g. social `x`,
  an `imageSourceType`). → map/clamp the value.
- **blank email / silent `createEmailTemplate` 400** — the template parses but the
  create rejects an enum value (see `error-classes.md` → blank-email).

FORBIDDEN: guessing the fix. Read the real schema/enum from redoapp FIRST — use
the `codebase_search` MCP (repo `redoapp/redo`); marketing trigger schemas live in
`redo/flows/common/src/schemas/marketing/`, and the field validator is
`redo/flows/common/src/validate-step-field-references.ts`.

## 3. Fix at the source, then re-run
Prefer fixing the mime parser/exporter over a one-off patch — then the re-run just
works and every future flow of this shape is fixed too.
- [ ] Reproduce the parse (no write, no real JWT needed):
      `KLAVIYO_API_KEY=… REDO_JWT=x FLOW_ID=<id> DIAGNOSE_ONLY=1 SKIP_AI=1 npx tsx src/flow/import-one.ts`
      → dumps `/tmp/mime-parsed-flow-<id>.json`. Confirm the offending value is gone
      and the step graph re-stitched (no dangling pointers to dropped ids).
- [ ] Re-run for real — supply the store's Klaviyo key + a **fresh** Redo JWT
      (they expire in days), then drop `DIAGNOSE_ONLY`. It re-creates the templates
      and posts `createAdvancedFlow`; success prints `✓ flow "…" → <id>`.

If the failing class is already fixed on `main`, the original 400 was just a stale
deploy — step 3 is only the re-run, no code change. (Redeploy so it stops recurring.)

## 4. Verify + report
- [ ] Step count / types are sane; nothing references a dropped step id.
- [ ] The flow shows up in Redo (imported **inactive** by policy — safe to review).
- [ ] Report any dropped steps (e.g. SMS in an email-only trigger) so the operator
      can rebuild them, and add the new error shape to `error-classes.md`.

# Flow DAG → Tree (branch-merge duplication)

## Problem
Klaviyo flows are DAGs — two branches from a conditional-split can reconverge on a
shared downstream action (e.g. branch A sends email 1, branch B sends email 2, both
continue into email 3). Redo's advanced-flow model is a tree: every step has exactly
one parent. Two steps pointing at the same child produces a runtime graph error.

## Approach
After `parseFlow` has converted Klaviyo actions 1:1 into Redo steps, run a
DAG-to-tree pass. When a step is reached by more than one parent, clone it (and
recursively clone its descendants) so each incoming branch has its own copy.

Semantics preserved: in Klaviyo each customer traverses exactly one branch, so
duplicating the shared tail means each branch's customers still get the tail
emails exactly once.

## Algorithm (DFS from trigger)
```
emitted = Map<originalId, count>   // how many times we've emitted this id
newSteps = []

clone(origId):
  if origId is missing from byId map (e.g. flow_end terminal): return origId
  if origId in current DFS stack: cycle — redirect to flow_end, warn, return flow_end
  count = emitted.get(origId) ?? 0
  emitted.set(origId, count + 1)
  newId = count === 0 ? origId : `${origId}__dup_${count}`
  clone = { ...byId[origId], id: newId }
  push stack(origId)
  if clone has nextId:       clone.nextId       = clone(clone.nextId)
  if clone has nextTrueId:   clone.nextTrueId   = clone(clone.nextTrueId)
  if clone has nextFalseId:  clone.nextFalseId  = clone(clone.nextFalseId)
  pop stack
  newSteps.push(clone)
  return newId

// Entry: trigger step keeps its id "trigger", its nextId gets cloned
trigger = byId["trigger"]
trigger.nextId = clone(trigger.nextId)
newSteps.unshift(trigger)
if flow_end was present in byId: newSteps.push(flow_end)
```

First visit keeps the original id; subsequent visits get `${id}__dup_${N}` so
SendEmailStep clones stay identifiable in imported Redo flows. Templates are
referenced by `templateId` (sentinel), not step id — cloning is safe.

## Edge cases
- **flow_end terminal** — kept as a single shared DO_NOTHING at the tail. It has
  no descendants, so sharing is fine; duplicating would bloat the step count with
  no behavioural difference.
- **Cycles** — Klaviyo flows should be DAGs but add a stack-based guard. If hit,
  redirect to flow_end and emit a `degraded-mapping` warning.
- **Blow-up** — if output step count > 10× input, emit a `degraded-mapping`
  warning so heavy merges are visible. Don't abort — let the merchant decide.
- **Unknown ids** — pointers referencing ids not in the byId map (shouldn't
  happen, but defensive): pass through unchanged (matches current behavior).

## Placement
New file `src/flow/treeify.ts` — single exported function
`treeifyFlow(steps: Step[], warnings: ParseWarning[]): Step[]`.

Called from `parseFlow` in `src/flow/parser.ts` immediately before constructing
the `AdvancedFlow`:
```typescript
const treeified = treeifyFlow(steps, warnings);
// ... use treeified instead of steps in the automation
```

## Verification
1. Run existing test fixtures through `export-flow.ts` — no-merge flows should
   produce byte-identical output (same ids, same step count).
2. Construct a small synthetic flow with a merge and verify:
   - Pre-merge branches have distinct ids on the shared tail
   - `__dup_` ids appear only on the second+ path
   - Post-merge step ids remain unique in the output array
3. Re-run full batch on `migrations/test-account/flows/*.json` — inspect output
   for any `__dup_` ids (indicates a real merge was detected) and confirm warnings.

## Non-goals
- No new step types, no schema changes.
- No collapsing equivalent clones back into a shared step (Redo doesn't support
  shared descendants).
- No optimization for "branches that always evaluate identically" — we clone
  even if the two branches emit the same sequence.

## Files changed
- `src/flow/treeify.ts` — new, algorithm + cycle/blow-up guards
- `src/flow/parser.ts` — call `treeifyFlow` before building `AdvancedFlow`

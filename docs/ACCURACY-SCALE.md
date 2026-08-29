# Migration accuracy scale

How to put a number on a Klaviyo → Redo migration, and what the number means
for whether you can hand it to a merchant.

The score is **measured, not judged**: `src/flow/verify-import.ts` reads the
store back out of Redo after an import and diffs it against what the parser
said should be there. `import-one.ts` runs it automatically on every import;
`score-store.ts` scores an already-migrated store after the fact.

## The unit

**One send.** Every email or SMS a customer would actually receive is one
scoreable item. Flows are not the unit — a 12-email flow that lands with 8
blanks is not "one flow, mostly fine," it is 8 broken emails a merchant will
find one at a time.

Trigger logic and step structure score as items too, so a flow that sends the
right emails on the wrong re-entry rule can't hide behind its content.

## The four verdicts

| Verdict | Weight | Means |
|---|---|---|
| `clean` | 1.0 | Landed as intended |
| `degraded` | 0.5 | Landed, but a merchant would notice something off |
| `broken` | 0.0 | Missing, blank, or wired to nothing |
| `unverified` | — | **Excluded from the denominator** |

```
score = (clean + 0.5 × degraded) / (clean + degraded + broken)
```

`unverified` is the honesty valve. Redo has no read API for SMS template
bodies (`createSmsTemplate` and `deleteSmsTemplate` exist; there is no
`getSmsTemplates`). The verifier can confirm an SMS step points at a real
template id, but it cannot read the copy. Scoring those `clean` would inflate
every SMS-heavy migration, so they sit outside the fraction and get counted
separately.

## The bands

| Grade | Score | What to do with it |
|---|---|---|
| **A** | 95–100 | Ship it. Spot-check and move on. |
| **B** | 85–94 | Ship after reviewing the flagged items. |
| **C** | 70–84 | Usable, but budget a real review pass. |
| **D** | 50–69 | Half the work is still manual. |
| **F** | <50 | Faster to rebuild by hand. |

## What gets checked

**Structure** — the flow exists in Redo; its step count and type sequence match
the parse. A dropped step is `broken`.

**Content** — every send step's `templateId` resolves to a real template in the
store, that template has at least one section, and its name doesn't start with
`[Placeholder]`. This is the check that catches the failure mode that reads as
success: the import log prints `done`, but the email is empty.

**Logic** — the trigger's `frequencyCap`, `shouldSkipSmartSending`, and
`skipConditions` match what the parser produced. Each parser warning of kind
`degraded-mapping`, `requires-review`, `skipped-flow`, `skipped-step`,
`unsupported-action`, or `unsupported-trigger` costs half an item. `gate` and
`skip` warnings are routine bookkeeping and cost nothing.

## Two scores per migration

Always report both:

- **Code alone** — what `import-one.ts` produced on the first pass, before
  anyone looked at it.
- **Hybrid** — after the Claude session diagnosed the failures, fixed the
  parser, and re-ran.

The delta is the number worth quoting. It is also the number that should shrink
over time: every fix that gets written back into the deterministic code moves
work from the hybrid column into the code-alone column permanently.

## Running it

Automatic, on every import — no flags:

```bash
KLAVIYO_API_KEY=… REDO_JWT=… FLOW_ID=… SKIP_AI=1 npx tsx src/flow/import-one.ts
```

The run now exits non-zero if the readback finds anything broken, so a
degraded import cannot be mistaken for a clean one.

Score a store that was migrated earlier:

```bash
REDO_JWT=… npx tsx src/flow/score-store.ts
```

`FLOW_FILTER="Welcome"` matches on name; `FLOW_IDS=abc,def` scores an explicit
list. With neither, it scores every flow in the store — including Redo's own
native flows, which is usually not what you want.

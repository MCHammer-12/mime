# Running a migration

You give three things and read one report. Everything between those two moments
is Claude and the deterministic code.

The code does the mechanical 90%. Claude resolves what the code can't map,
decides it, records why, QAs the result, and writes what it learned back into
the code so the next merchant doesn't hit the same gap.

**Claude does not stop to ask you about merchant-visible choices.** It makes
them and reports them. The safety net is that every flow lands **inactive** —
nothing can send until a human reads the report and turns it on.

Setup is in [ONBOARDING.md](ONBOARDING.md). Commands are in
[OPERATOR-QUICKSTART.md](OPERATOR-QUICKSTART.md).

---

## The loop

| # | Phase | Time |
|---|---|---|
| 1 | You give the input | 1 min |
| 2 | Recon — what's already in the store | 2 min |
| 3 | Diagnose — every gap, before anything is written | ~1 min per flow |
| 4 | Import | ~2 min per flow |
| 5 | QA — read the store back and score it | 5 min per store |
| 6 | Write-back and report | 10 min |
| 7 | You read the report | 5 min |

---

## 1. The input

Three things:

1. **Klaviyo private API key** (`pk_…`) — read access is enough
2. **The store's name in Redo** — the name, not an id
3. **The flows to bring over**, by name

Names straight off a call transcript are fine.

Two things stop the run here, both because they are bad *input* rather than
decisions to make:

- **The store name matches more than one Redo store.** Claude lists the
  candidates and stops. Writing flows into the wrong merchant's account is the
  one mistake in this pipeline that can't be undone from outside.
- **The clone is behind `origin/main`.** Someone fixed a mapping you don't have.
  Running anyway re-imports a solved bug and re-learns a solved mapping.

---

## 2. Recon

Claude reads the Redo store before writing anything: existing flows, their
trigger keys, existing templates.

Re-running an import creates duplicate flows — it does not update them. If the
store already has flows under these names, Claude either imports under
`NAME_SUFFIX` or deletes the previous set, and says which in the report.

One person per store at a time.

---

## 3. Diagnose

`DIAGNOSE_ONLY=1` on every flow before importing any of them. It parses,
resolves templates, prints every gap, writes nothing.

What comes back:

- **Trigger mapping** — which Redo trigger each Klaviyo trigger became
- **Warnings** — `degraded-mapping`, `requires-review`, `skipped-step`,
  `unsupported-action`, `unsupported-trigger`
- **Vacuous conditions** — a condition Redo's schema can't express, which would
  match no customer and send everyone down the false branch

Claude resolves each one and records the decision. The order it tries:

1. **Map it properly** and put the mapping in the code — the write-back loop.
   This is the outcome that makes the next run better.
2. **Map it approximately**, if the degradation is smaller than the loss. The
   approximation and what it costs go in the report.
3. **Import it degraded on purpose** (`ALLOW_VACUOUS_CONDITIONS=1`) when nothing
   maps, and report it as a known issue with what a human has to do about it.

Nothing here waits on you. Every choice is in the report.

---

## 4. Import

Same command, `DIAGNOSE_ONLY` dropped. Every flow lands **inactive**.

Images are pulled off Klaviyo's CDN and re-uploaded to Redo as part of the
import. Left alone they break the moment the merchant stops paying Klaviyo,
months after anyone is watching. (`SKIP_IMAGE_REHOST=1` opts out.)

`verify-import.ts` runs at the end of each import: it reads the store back and
diffs it against what the parser said should be there. The run exits non-zero if
anything landed broken, so a degraded import can't be mistaken for a clean one.

---

## 5. QA

`verify-import.ts` compares Redo against mime's *own parse*. That's a
self-consistency check: if the parser is wrong, the verifier agrees with it and
reports clean. Bailey's Blossoms passed it at 100%.

`qa-store.ts` is the second pass, and it checks things that are broken
regardless of what the parse thought.

```bash
REDO_JWT="$(jwt-bandit <teamId>)" FLOW_FILTER="<name fragment>" \
  QA_JSON=/tmp/qa.json npx tsx src/flow/qa-store.ts
```

Scope it with `FLOW_FILTER` or `FLOW_IDS`. Unscoped it audits the whole store,
where the merchant's own live flows are supposed to be on and to share triggers
with each other — so it skips the inactive-on-import check and reports only
collisions this migration is part of.

What it asserts:

| | Check | Why it isn't caught upstream |
|---|---|---|
| **Logic** | No condition with an empty conditions array | Empty evaluates FALSE — everyone takes the false branch and the true branch's emails never send, silently |
| | No two flows sharing a trigger key | Activating both double-sends. A migrated flow can collide with one that was already there |
| | Nothing active | Imports land inactive until a human decides |
| **Structure** | Every step reachable from the trigger | A dropped step re-stitched wrong strands the chain. Edges aren't always top-level — an `ab_test` carries one per variant |
| | No pointer into a step that doesn't exist | |
| **Fidelity** | Render every template via `previewEmailTemplate` and read the HTML | This is what the merchant actually receives |
| | No surviving `{{ … }}` / `{% … %}` | Ships literally to the customer |
| | Unsubscribe present in the *rendered* output | Checking for a footer block gives both false positives and false negatives |
| | No `d3k81ch9hvuctc.cloudfront.net` assets | Images break when the merchant leaves Klaviyo. Imports re-host as they go; a store migrated before that landed is fixed with `rehost-existing.ts` |
| | No Klaviyo click-tracking link hosts | |
| | Real subject lines, not `Email #1 Subject` | |

Score = `(clean + 0.5 × degraded) / (clean + degraded + broken)`. Grades in
[ACCURACY-SCALE.md](ACCURACY-SCALE.md). Non-zero exit on any broken check.

**Two things this can't see**, and they go in the report as such:

- **Discount parity** — that the code is live in Shopify, and that amount, type,
  and static-vs-dynamic match the Klaviyo original across body copy, CTA link,
  subject, and text baked into an image.
- **Visual judgement** — a white block on a tinted background, a stock image the
  importer left behind. Claude opens a few and says what it sees; a person
  looking at the builder is still better at it.

---

## 6. Write-back and report

**Write-back.** A mapping Claude works out goes into the code, not just into
this one import, and gets committed and pushed in the same run. Next merchant,
it happens with no intervention. Skipping this is how five people solve the same
problem five times.

Merchant-specific facts — a store's discount prefix, their org name — go in the
run notes instead. Those aren't mappings.

**Report.** Four sections:

1. **Known issues nobody fixed** — what a human has to decide or do, each with
   the flow and the reason. This is the section you act on.
2. **Code fixed this run** — the mappings that went back into mime, with the
   commit. Every entry here is a gap that won't recur.
3. **Decisions made without asking** — every merchant-visible call, with the
   alternative that was rejected. This is where you overrule Claude.
4. **The numbers** — score, per-flow breakdown, what's inactive.

Everything is inactive until a human turns it on. The report says so explicitly.

Write the report to `migrations/<store>/<date>-write-back-report.md` — that path
is gitignored, which is where merchant data belongs — and publish it as an
artifact so it has a link the team and the agency can open.

---

## Copy-paste prompts

**Start a run**

```
Migrate <store name>. Klaviyo key pk_XXXX.
Bring over these flows: <names>.

Run the whole loop in docs/HYBRID-RUN.md end to end. Don't stop to ask me about
merchant-visible choices — decide them, and put every decision in the report.
Publish the report as an artifact when you're done.
```

**QA a store that's already imported**

```
QA the <store name> migration: resolve the store, run qa-store.ts scoped to the
migrated flows, and check discount parity against Klaviyo (key pk_XXXX) by hand.
Report findings ranked by severity. Don't change anything yet.
```

**Re-run flows a later fix would now import correctly**

```
Run rerun-stale for <store name> and re-import anything it lists.
```

That last one exists because a fix landing mid-run leaves earlier flows stranded
on the old code. `rerun-stale.ts` reads the run ledger and finds them.

---

## What still reaches Michael

Not as a mid-run question — as a flagged item in the report.

- The merchant needs a Redo-side schema change (a field Redo doesn't have)
- A flow can't be expressed in Redo at all and needs a rebuild decision
- A discount code that has to be created on the Redo side
- The store already has a partial migration from someone else

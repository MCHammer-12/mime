# Running a hybrid import

The deterministic code does the mechanical 90%. Claude resolves what it can't
map, checks the result, and writes what it learned back into the code. You
approve anything a merchant would notice.

Setup is in [ONBOARDING.md](ONBOARDING.md). Commands are in
[OPERATOR-QUICKSTART.md](OPERATOR-QUICKSTART.md). This is how to actually work
the loop.

---

## The loop

| # | Phase | Who drives | Time |
|---|---|---|---|
| 1 | Scope | You | 2 min |
| 2 | Recon | Claude | 2 min |
| 3 | Diagnose | Claude, you answer | ~1 min per flow |
| 4 | Import | Claude | ~2 min per flow |
| 5 | QA | Claude, you spot-check | 10–30 min per store |
| 6 | Write-back and report | Claude, you approve | 10 min |

Phases 3 and 5 are the ones that decide the score. Everything else is plumbing.

---

## 1. Scope

Give Claude three things:

1. Merchant name
2. Klaviyo private API key (`pk_…`) — read access is enough
3. The flows and templates to bring over, by name

Names straight off the call transcript are fine. Claude matches them to Klaviyo
ids and reads back the list before touching anything. If a name is ambiguous
(a live flow and a `(UNUSED)` twin) it asks which.

---

## 2. Recon

Claude checks what already exists in the Redo store before importing anything.

**Do not skip this and do not let it be skipped.** Re-running creates duplicate
flows, it does not update them. If the store already has flows with these names,
decide *now* — delete the old ones, or import with `NAME_SUFFIX`. Sorting it out
afterward means untangling two sets of near-identical flows by hand.

One person per store at a time.

---

## 3. Diagnose

`DIAGNOSE_ONLY=1`. Parses the flow, resolves the templates, prints every gap,
writes nothing. Run it on every flow before importing any of them.

What comes back:

- **Trigger mapping** — which Redo trigger each Klaviyo trigger became
- **Warnings** — `degraded-mapping`, `requires-review`, `skipped-step`,
  `unsupported-action`, `unsupported-trigger`
- **Hard stops** — a condition that would match no customer blocks the import
  outright, because a flow that looks imported and silently behaves differently
  is worse than one that didn't import

Your job in this phase is to answer the merchant-visible questions. Claude brings
a recommendation with the trade-off, not an open question. Say yes, or name the
other option.

Typical ones: a trigger with no Redo equivalent, a font not in the brand kit, a
discount that has to be created Redo-side, a condition Redo's schema can't
express.

Everything mechanical, Claude decides on its own.

---

## 4. Import

Same command, `DIAGNOSE_ONLY` dropped. Every flow lands **inactive**. Nothing
you run here can send an email.

`verify-import.ts` runs automatically at the end of each import: it reads the
store back out of Redo and diffs it against what the parser said should be
there. The run exits non-zero if anything landed broken, so a degraded import
can't be mistaken for a clean one.

Read the score line. Grades are in [ACCURACY-SCALE.md](ACCURACY-SCALE.md).

---

## 5. QA

This is the phase that produces the delta. Bailey's Blossoms scored 38 out of
100 on the code's first pass and 100 after this phase. Skipping it means handing
the merchant the 38.

Three tiers, and only the first is automated:

| Tier | Question | Who |
|---|---|---|
| **Wiring** | Does the flow exist, with the right steps, pointing at real templates? | `verify-import.ts`, automatic |
| **Fidelity** | Is what's inside the email correct? | Claude, by hand today |
| **Visual** | Does it look right? | You, always |

### Fidelity checklist

Ask Claude to run all of these. Every one is a real failure that has shipped.

**Email content**

1. Render each template (`previewEmailTemplate`) and grep the output — **any**
   surviving `{{ … }}` or `{% … %}` ships literally to the customer.
   `{% current_year %}` and `{{ organization.name }}` are the usual survivors.
2. Unsubscribe link present in the **rendered** output of every marketing email.
   Checking for a footer *block* gives both false positives and false negatives.
3. Discount matches the Klaviyo original on all five axes: amount, type, the code
   itself (and that it is live in Shopify), static vs dynamic, and consistency
   across body copy, CTA link, subject, and any text baked into an image.
4. Subject lines are real copy, not `Email #1 Subject` or `[Placeholder]`.
5. Images and fonts: no `d3k81ch9hvuctc.cloudfront.net` URLs left pointing at
   Klaviyo's CDN, fonts resolved to the brand kit, links on the merchant's own
   domain.

**Flow logic**

6. No condition step with an empty conditions array. An empty condition
   evaluates FALSE and routes everyone down the false branch — the true branch
   becomes dead code and those emails never send. It is silent.
7. Skip conditions have the right polarity. Klaviyo "enter if A **and** B" is
   Redo "skip if not-A **or** not-B". Getting the mode wrong over-sends.
8. Every step is reachable from the trigger, and no send step is `disabled`.

### Visual

Open two or three of the imported emails in Redo's builder next to the Klaviyo
original. Structural checks can't see a white block sitting on a tinted
background or a stock image the importer left behind.

---

## 6. Write-back and report

**Write-back.** When Claude works out a mapping the code didn't know — a
trigger, a metric, a font, a condition — that mapping goes into the code, not
just into this one import. Claude will propose the diff. Read it, approve it,
let it commit and push. Anyone on the team can approve.

Next merchant, it happens with no intervention. Skipping this is how five people
solve the same problem five times.

Merchant-specific facts (a store's discount prefix, their org name) go in the run
notes instead. Those aren't mappings.

**Report.** What the merchant gets: what landed, what was mapped approximately,
what was dropped and why, and anything they need to do on their side. Everything
is inactive until a human turns it on — say so explicitly.

---

## Copy-paste prompts

**Start a run**

```
Migrate <merchant>. Klaviyo key pk_XXXX, Redo team <24-hex id>.
Bring over these flows: <names>.

Check the store for existing flows first, diagnose everything before importing
anything, and stop for anything a merchant would notice.
```

**QA a store that's already imported**

```
QA the <merchant> migration in Redo team <24-hex id> against Klaviyo
(key pk_XXXX). Run the fidelity checklist in docs/HYBRID-RUN.md — render every
template and check surviving Liquid, unsubscribe, discounts, subjects, assets,
plus empty conditions, skip polarity, and reachability on every flow.
Report findings ranked by severity. Don't change anything yet.
```

**Re-run flows a later fix would now import correctly**

```
Run rerun-stale for team <24-hex id> and re-import anything it lists.
```

That last one exists because a fix landing mid-run leaves earlier flows stranded
on the old code. `rerun-stale.ts` reads the run ledger and finds them.

---

## Stop and ask Michael

- The merchant needs a Redo-side schema change (a field Redo doesn't have)
- A flow can't be expressed in Redo at all and needs a rebuild decision
- Anything involving a discount code that has to be created on the Redo side
- The store already has a partial migration from someone else

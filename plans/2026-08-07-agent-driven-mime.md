# Plan: Agent-driven mime

**Status:** Draft
**Created:** 2026-08-07

## Context

mime brings over ~90% of a Klaviyo account at ~90% fidelity. The residual 10% is not
a coverage problem — it is structural.

The current design makes the **tool the actor and the human the fallback**. Every case
mime can't resolve exits the system: into a `warning`, into a troubleshoot bundle, into
a feedback task file under `plans/feedback/`. The planner/executor workflow in
[CLAUDE.md](../CLAUDE.md) exists specifically to route those exits back in. The exits
are by design, so parser work never closes them — it only moves where the exit is.

Agent-driven inverts it: **the agent is the actor, the tool is the instrument.** An
unresolvable case stops being an exit and becomes the next thing worked in the same
session. The tool's job changes from "handle every case" to "expose enough state that
something smarter can finish it" — which is a strictly easier tool to build.

Target workflow: customer call → transcript yields the list of forms/flows/templates to
migrate → that list drives a run → agent executes most of it via mime primitives and
hand-finishes the rest.

**Decisions taken (2026-08-07):**
- **Sequencing** — prove the loop locally on a real migration first; the MCP surface is
  derived from what the run actually uses, not designed up front.
- **Autonomy** — decide freely on mechanical choices; stop and ask on anything a
  merchant would notice. Flows continue to land inactive regardless.

**Scope revised (2026-08-10):**
- **Signup forms dropped.** Out of scope to keep the first loop small. Former S0/S5
  removed; the spike findings are preserved in git history at `6eec10e` if they come back.
- **Discount codes are not blocked and not an ask.** Re-checked: `createDiscount` is a
  live merchant RPC (`POST /discounts-rpc/createDiscount`, input
  `{ discountConfiguration: draftDiscount }`, output `redoDiscountSchema` → bind
  `DiscountBlock.discountId`). Already scoped end-to-end in
  [`plans/feedback/clusters/discount-codes.md`](feedback/clusters/discount-codes.md).
  It becomes a **post-import second pass** (see S6), which is the better decomposition:
  a discount ambiguity stops gating the flow that contains it.
- **Deploy target** — `redoapp/redotech-internal-tools`, reachable over MCP. Confirmed
  it has two distinct doors: `.agents/skills/` (instructions, auto-live team-wide on
  merge to main — this is how `change-marketing-automation-trigger` reaches a session)
  and `apps/` + `mcp/` (real compute). mime's engine needs the second; the judgment
  layer belongs in the first.

## Approach

Three layers, in dependency order.

### 1. Result contract

Today every primitive returns ok-or-failed. That collapses two unrelated things:
"this crashed" and "this needs a decision." An ambiguous trigger and a missing font are
not failures, they are **questions** — and the whole 10% lives in that category.

```ts
type MigrationResult<T> =
  | { status: "ok";          artifact: T; notes: Note[] }
  | { status: "needs_input"; question: Question; resume: ResumeToken }
  | { status: "failed";      diagnosis: Diagnosis }

type Question = {
  visibility: "mechanical" | "merchant_visible";
  prompt: string;
  options?: Choice[];   // when the answer space is closed (e.g. trigger picker)
  evidence: unknown;    // the Klaviyo source that produced the ambiguity
};
```

`visibility` **is** the autonomy policy, encoded. `mechanical` → agent resolves and
records the assumption. `merchant_visible` → agent stops and asks Michael. No separate
policy layer, no judgment call at each call site.

`ResumeToken` is what makes a run restartable without re-deriving state — it carries
enough to re-enter the primitive at the decision point once the answer exists.

### 2. Run manifest

A run becomes data, not dashboard state:

```
runs/<merchant>-<YYYY-MM-DD>/manifest.json
  source:  { klaviyoAccount, apiKeyRef }
  target:  { storeId, jwtRef }
  items:   [{ kind, sourceId, name, status, result?, questions[] }]
```

`kind` ∈ `flow | template | form | segment | campaign`. `status` ∈
`pending | ok | needs_input | failed | skipped`. Resumable, auditable, diffable, and
it is the artifact the call transcript writes into.

Credentials are referenced, never inlined — the manifest is a working file and merchant
keys have already leaked into transcripts once this year.

### 3. MCP surface

Deliberately **last**. Derived from the primitives a real run actually reaches for, so
we don't design a tool contract against guesses. See Section 7.

## Alternatives considered

- **Keep improving the parser.** Rejected — the failure classes we hit are decisions
  without a right answer (which trigger, which font, what discount amount), not parsing
  bugs. More parser sophistication cannot resolve an ambiguity that needs a human fact.
- **Port mime into the internal-tools monorepo first.** Rejected for now per sequencing.
  mime is plain tsx/ESM with no build step; internal-tools is pnpm + turbo + mise. That
  is a real port, and doing it before we know the tool surface means porting code we may
  delete.
- **Skills-only, no MCP server.** Rejected as an endpoint (the engine — cheerio, mjml,
  the renderer — is real compute and can't live in a markdown skill), but correct as the
  *first* step: the judgment layer ships as skills long before the engine moves.

## Sections

Ordered by readiness, not by the order the targets were named. They are not
equal-effort and pretending otherwise would mis-sequence the work.

### S1 — Result contract + manifest
Implement `MigrationResult`, `Question`, `ResumeToken`, manifest read/write. Retrofit the
four existing one-shot primitives (`flow/import-one.ts`, `flow/import-template-one.ts`,
`segments/import-one.ts`, `flow/build-sms-variant.ts`) to return it. These already have
the right escape hatches (`FORCE_TRIGGER`, `DIAGNOSE_ONLY`) — this is typed I/O around
proven code, not a rewrite.

### S2 — Transcript → manifest
AskElephant MCP (`get_transcript`, `list_my_engagements`) is already wired, so this is
real today. Extract the named forms/flows/templates from a call, reconcile against what
`extract-flows` / `extract-templates` actually find in the account, and write the
manifest. Reconciliation matters — the customer's spoken list and the account contents
will not agree, and the disagreement is itself a question worth surfacing.

### S3 — Problem triggers *(highest volume, ready now, pure mime-side)*
The recurring class: no clean Redo equivalent, or a step references a field the trigger
schema lacks (Felicity's SMS-phone-field failure). Convert from silent-drop/hard-fail into
a `needs_input` carrying the `MARKETING_TRIGGER_OPTIONS` picker as `options`. Most
resolve mechanically; genuinely ambiguous ones become one question with a real choice list.

### S4 — Fonts
Partly built already (auto-upload + preflight gate). Closing the gap: non-Google
families, weight mismatches, and preflight blocks become `needs_input` with a proposed
substitution rather than a hard block. Substitution is `mechanical`; a brand's signature
display face is `merchant_visible`.

### S6 — Discount codes *(post-import second pass)*
Not blocked. `POST /discounts-rpc/createDiscount` exists and takes `draftDiscount`
(`{ name, provider, codeGenerationStrategy: { strategy, code }, expiration,
discountSettings, category? }`). Per-recipient codes = `strategy: "dynamic"`, which is
what `{% coupon_code %}` means in Klaviyo.

Running it **after** the flow lands rather than inside the import is the point: today a
coupon whose amount we can't determine can stall the whole flow. Split apart, the flow
imports with the discount block unbound, and a second pass creates the discount and binds
`discountId`. The unknown amount becomes one `merchant_visible` question against a landed
flow instead of a blocker on it.

Amount/type is **operator-supplied, not fetchable** — refuted against live Klaviyo
2026-06-26: `GET /api/coupons` returns 0 objects and the coupon schema has no value field;
the percentage lives in Shopify. So this is exactly one question per distinct coupon,
prefilled from a copy heuristic ("15% OFF" in the body).

### S7 — MCP packaging
Only after a full merchant migration has run agent-driven. Split by door:
- **Skills** (`.agents/skills/`) — the judgment: how to read a transcript into a manifest,
  how to resolve a trigger question, how to pick a font substitution.
- **MCP server** (`apps/` or `mcp/`) — the engine: parse, render, import primitives.

## First run — Piperblue Makeup (2026-08-10)

Three flows, chosen because each exercises a different failure class. Klaviyo key
received 2026-08-10; all three diagnosed. **Still blocked on a Redo JWT for
Piperblue's store** — nothing can be imported, only diagnosed.

Diagnosis runs need no Redo credentials:

```bash
KLAVIYO_API_KEY=... DIAGNOSE_ONLY=1 SKIP_AI=1 FLOW_ID=Sj5GSG npx tsx src/flow/import-one.ts
```

| flow | steps before | steps after | status |
|---|---|---|---|
| `XWfahQ` | 52 (27 dup) | **17** (4 dup) | parses; 2 segment conditions need manual config |
| `Sj5GSG` | 758 (727 dup, 24.5x) | **34** (9 dup) | parses; SMS dropped (trigger schema) |
| `S6ghDv` | — | — | **fails**: no Redo trigger for the Okendo metric |

### `XWfahQ` — not a control after all
Intended as the baseline. It has the same disease as `Sj5GSG`: six identical
`profile-group-membership` re-checks against one list (`XXEwgb`), expanding 23 actions
into 52 steps. Michael's rule 2 is not repeat-customer-specific — it generalizes to *any*
repeated identical predicate, and that generalization is what shipped.

Residual: 2 `requires-review` warnings for the surviving membership splits. The list must
exist as a Redo segment before import.

### `Sj5GSG` — branch explosion *(flatten, don't reproduce)*
Redo can't merge branches, so Klaviyo's conditional splits expand combinatorially through
`treeify` (each merge point duplicates the downstream subtree, marked `__dup_`). This flow
has enough splits that a faithful import is unusable.

Michael's two flattening rules, which are semantic, not structural — they change what the
flow *is*, so they need to be recorded as decisions, not silently applied:

1. **Drop SMS-capability splits entirely.** Klaviyo checks "can this person receive SMS?"
   before each SMS send. Redo doesn't need the branch — send the SMS, and anyone not
   subscribed simply doesn't receive it. Every such split collapses to its send.
2. **Hoist the repeat-customer check to a single branch at the top.** Klaviyo re-checks
   "placed an order at least once over all time" at each decision point. Replace with one
   split at the entry, producing two independent sides of the welcome flow. Everything
   downstream inherits its side instead of re-testing.

Rule 2 is the one that kills the exponent: N sequential re-checks of the same predicate
become 1. Verify by comparing step count before/after on the same parse.

**SHIPPED 2026-08-10** — [`flatten.ts`](../src/flow/flatten.ts) +
[`treeify.ts`](../src/flow/treeify.ts), covered by
[`flatten.smoke.ts`](../src/flow/flatten.smoke.ts).

Measured: **758 → 34 steps**. The flow is now literally one split at the top feeding two
8-email tracks, which is what rule 2 asked for.

Rule 2 is implemented as path-sensitive folding rather than a literal hoist: when a
condition's outcome is already decided on the current root-to-node path, treeify descends
only into the known branch. Same result, and it generalizes to any repeated predicate
(which `XWfahQ` needed) without special-casing repeat-customer.

Safety check — comparing root-to-leaf send sequences before vs. after: **0 gained, 62 of
64 dropped.** Nobody receives a sequence they couldn't have before. The 62 dropped
combinations were phantoms that required the customer to be a repeat buyer at one split
and not at the next; only the all-yes and all-no tracks are reachable by a real profile.

Two things rule 1 did *not* recover:
- Piperblue's SMS is dropped anyway, for an unrelated reason: the flow's trigger schema is
  `email_marketing_signup`, which has no phone field, so Redo can't send SMS from it at
  all. Rule 1 collapses the consent split correctly, but the send it was guarding is gone.
  Recreating this as a dedicated SMS flow is a separate decision.
- 8 `delay_until_time` values (send at 10:00) are still lost — Redo's WAIT has no
  time-of-day field.

### `S6ghDv` — Okendo custom-event trigger *(new capability)*
Klaviyo triggers this on an Okendo metric. Reference implementation on the Redo side is
the existing "color match quiz completed" trigger.

**Confirmed 2026-08-10.** Parse fails outright — the flow is skipped, not degraded:

```
21 actions → unsupported-trigger: metric "Submitted Okendo Survey" (Okendo)
has no Redo trigger equivalent — flow "Customer Survey" skipped
```

`"Submitted Okendo Survey"` is the literal string that becomes `eventName` on the Redo
custom-event trigger step.

**Redo side — the target exists.** `redo/flows/common/src/triggers.ts` has a first-class
generic custom-event trigger: category `"Custom Event"`, `CustomEventTriggerKey.CUSTOM_EVENT`
(`"custom_event"`). The step shape
([`advanced-flow-db-parser.ts:848`](https://github.com/redoapp/redo/blob/main/redo/flows/common/src/advanced-flow-db-parser.ts#L848)) is:

```ts
{ category: "Custom Event", key: "custom_event",
  eventName: string,
  triggerSpecificFields?: { conditions?: CustomEventPropertyCondition[] } }
```

Matching is `triggerStep.eventName === schemaInstance.eventName`, plus optional
property conditions evaluated against the event payload
(`redo/flows/service/src/get-relevant-flows.ts:223`). That maps cleanly onto Klaviyo:
metric name → `eventName`, `trigger_filter` → `conditions`.

**mime side — the gap.** mime cannot emit this at all today. `custom_event` appears
nowhere in `src/flow/`, and `MARKETING_TRIGGER_OPTIONS` has 46 entries, none of them a
custom event. Unknown custom metrics currently resolve to NULL → trigger picker
(the 2026-06-12 never-silent-default rule, guarded by
[`survey-trigger.smoke.ts`](../src/flow/survey-trigger.smoke.ts)). That rule stays; this
adds a real destination the picker can point at.

**Genuinely open — needs Redo-side confirmation.** Whether Okendo events actually reach
Redo's custom-event pipeline for this store, i.e. what populates `schemaInstance.eventName`.
The trigger can be authored either way, but it won't fire without the event source. This
is the piece Michael flagged as needing help from the Redo side.

## Verification

The run itself is the test. On a real merchant migration, measure:

1. **Landed without human touch** — items reaching `ok` with zero questions asked.
   Baseline is today's ~90%.
2. **Questions asked** — count and content. The number should be small and every one
   should be a real decision, not a diagnostic the agent could have run itself.
3. **Policy correctness — the load-bearing check.** Zero `mechanical` questions escalated
   to Michael, and zero `merchant_visible` decisions made silently. This tests the
   autonomy contract directly; getting the count down while silently guessing on
   merchant-visible calls is a regression, not a win.
4. **Resumability** — kill a run mid-flight, resume from the manifest, confirm no
   duplicate Redo objects are created.

Per-section gates: S1 typechecks + existing smoke suite green (`src/**/*.smoke.ts`).
S3/S4 each need a regression case built from a bundle that previously dead-ended —
Felicity for triggers, Blackline for fonts.

## Open questions

- **Okendo event source** — does Okendo deliver custom events into Redo for this store?
  Blocks `S6ghDv` firing (not authoring). Redo-side question.
- **Repo boundary** — mime is `MCHammer-12/mime` (personal), internal-tools is
  `redoapp/` (org). S7 either ports mime in or has internal-tools wrap it. Deferred
  until a real run tells us how much of mime the surface actually needs.
- **Credential handling** — merchant Klaviyo keys and Redo JWTs are per-run inputs. Once
  this runs from internal-tools rather than a local shell, they need somewhere real to
  live. Not urgent while local; blocking before S7.

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
received 2026-08-10. JWT unblocked the same day via `jwt-bandit`; target store is
`68b1eaed06badabc590b9168`.

Diagnosis runs need no Redo credentials:

```bash
KLAVIYO_API_KEY=... DIAGNOSE_ONLY=1 SKIP_AI=1 FLOW_ID=Sj5GSG npx tsx src/flow/import-one.ts
```

| flow | steps before | steps after | outcome |
|---|---|---|---|
| `XWfahQ` | 52 (27 dup) | **17** (4 dup) | **imported** `6a7a52b68cc1bc50abdc5751`, 10 templates |
| `Sj5GSG` | 758 (727 dup, 24.5x) | **34** (9 dup) | **imported** `6a7a5297adb058147586583e`, 14 templates |
| `S6ghDv` | — | **41** (18 dup) | **imported** `6a7a5983442ce8cc95b36548`, 9 templates — trigger has no event source yet |
| `Sj5GSG` (SMS) | 36 | **3** | **imported** `6a7a5b6e54eff5fba6cc71c6`, 1 SMS template |

Both imports ran with **AI transformations skipped** (`ANTHROPIC_API_KEY` unset in the
run shell → `skipAi`). Image-as-button conversion, coupon rewrites, and the other AI
passes did not run for those 24 templates. Re-run with a key before treating template
fidelity as measured.

All four landed **inactive** (`enabled: false`), per the standing rule.

**Duplicates from a June run — resolved.** A prior mime pass on 2026-06-22 had imported
two of these flows un-flattened and never cleaned them up:

| name | 2026-06-22 | 2026-08-10 |
|---|---|---|
| Piper Blue NEW Welcome Series | `6a397ced0b4abb7a4e08dcbb` — **760 steps** | `6a7a5297adb058147586583e` — **34 steps** |
| Makeup Academy Email Flow | `6a397cd2fe54be008c009ee7` — 54 steps | `6a7a52b68cc1bc50abdc5751` — 17 steps |

Worth keeping as the flattening receipt: 760 → 34 on the same source flow, in one store.
Michael approved deleting the June pair; both removed via `deleteAdvancedFlow` after
snapshotting all 52 flows. Store now holds one copy of each.

Four other June-run flows remain and were left alone: `Abandoned Cart Reminder - LP`,
`Back In Stock Flow - Standard`, `Perfect Match Sample Bundle Purchased`,
`Customer Winback - LP`.

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
  **Recreated as a dedicated SMS flow** — see below.
- 8 `delay_until_time` values (send at 10:00) are still lost — Redo's WAIT has no
  time-of-day field.

### `Sj5GSG (SMS)` — the dropped SMS, recreated
Michael's call: recreate as a dedicated SMS flow rather than leave the send behind.
[`build-sms-variant.ts`](../src/flow/build-sms-variant.ts) already did the core of this
(keep SMS + timing + conditions, drop the emails, force the `sms_signup` trigger), but its
first output was a flow that sends one text and then sits through **seven chained waits —
20 days — doing nothing**, twice, once per side of a repeat-customer split whose two
branches were byte-identical after the email drop.

Both defects are artifacts of dropping the emails, not structure the merchant authored.
Three passes added (commit `460350f`):

- **`pruneDeadTails`** — any pointer whose subtree can no longer reach a send is
  redirected to the shared `flow_end`. Kills wait chains that only ever spaced out emails.
- **`collapseIdenticalBranches`** — a condition whose two branch signatures match
  (ignoring treeify's `__dup_N` suffix) no longer decides anything; splice it out.
- **`pruneUnreachable`** — sweep what the first two orphaned.

Also filters `placeholderSmsTemplates` to sentinels a surviving step still references —
every placeholder becomes a real `SmsTemplate` in the merchant's account, so a dropped
send would otherwise leave an orphan template behind.

**36 → 20 (email drop) → 3 steps.** Sends and their timing are untouched; only steps that
provably do nothing were removed. The honest read is that Piperblue's welcome series had
exactly one SMS, fired immediately on signup — the other 17 steps were email scaffolding.

Imported as `6a7a5b6e54eff5fba6cc71c6`, inactive. Its one text carries a **static** code
(`SMS5`, hardcoded in the body), not `{% coupon_code %}`, so it needs none of the
discount-block work from S6.

### `S6ghDv` — Okendo custom-event trigger *(new capability)*
Klaviyo triggers this on an Okendo metric. Reference implementation on the Redo side is
the existing "color match quiz completed" trigger.

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

**mime side — SHIPPED 2026-08-10** (`334ab61`, covered by
[`custom-event-trigger.smoke.ts`](../src/flow/custom-event-trigger.smoke.ts)).
`custom_event` is now a `MARKETING_TRIGGER_OPTIONS` entry; `parseFlow` fills `eventName`
from the flow's own Klaviyo metric name. The 2026-06-12 never-silent-default rule is
untouched — an unmapped metric still resolves to NULL and goes to the picker (guarded by
[`survey-trigger.smoke.ts`](../src/flow/survey-trigger.smoke.ts)). What changed is that
the picker now has a real destination to point at.

The same commit fixes a latent hard-failure: every send-email step hardcoded
`recipientNameFieldName: "customerFullName"`, a field `customEventSchema` does not have
(it splits into `customerFirstName` / `customerLastName`). Redo's
`validateStepFieldReferences` + `advanced-flows-repo.ts:345` reject the entire
`createAdvancedFlow` on that, so this would have 400'd every custom-event flow.

`S6ghDv` now parses to 41 steps / 9 templates with 4 residual warnings, including a
`trigger_filter` — *"Survey Name equals Customer Survey"* — that Redo's
`triggerSpecificFields.conditions` (`{property, operator: "equals", value}`) is the exact
home for. Not wired yet: filling it requires knowing the property key the Okendo→Redo
payload actually uses, which is downstream of the blocker below.

**Shape verified against the reference flow.** Read back Piperblue's hand-built
`Color Match Quiz Completed` (`6a7a1318f4e12088e8eaf6e1`, created 2026-08-10 18:06 by
the Redo side). Its trigger step is:

```json
{ "type": "trigger", "id": "trigger", "schemaType": "custom_event",
  "category": "Custom Event", "key": "custom_event",
  "eventName": "Submitted Okendo Quiz", "shouldSkipSmartSending": false }
```

Two things confirmed, not inferred: `eventName` is the **Klaviyo metric name verbatim**
(which is exactly what `parseFlow` now derives), and `triggerSpecificFields` is absent —
the conditions array really is optional. All 12 of its `send_email` steps use
`recipientNameFieldName: "customerFirstName"`, independently confirming the field fix.

**No event source yet — imported anyway, on Michael's call.** Verified live 2026-08-10
against Piperblue (`68b1eaed06badabc590b9168`):

```
POST /marketing-rpc/getCustomEventNames  →  {"output":{"eventNames":[]}}
```

That handler lists names Redo has actually *ingested*. My recommendation was to hold;
Michael's call was to import now and write down what's needed. Imported as
`6a7a5983442ce8cc95b36548`, inactive. It is syntactically correct and will begin firing
the moment ingestion exists — no re-import needed, no mime-side work outstanding.

**Note this cuts both ways: the reference flow is inert too.** `Color Match Quiz Completed`
(`6a7a1318f4e12088e8eaf6e1`), the Redo-authored flow Michael pointed at as the pattern,
triggers on `Submitted Okendo Quiz` — also absent from `getCustomEventNames`. The pattern
is authored correctly and is equally waiting on ingestion.

#### What Redo needs to build (the ask from 2026-08-10)

Nothing needs designing — it is already specced.
[`docs/design/okendo-marketing-integration.md`](https://github.com/redoapp/redo/blob/main/docs/design/okendo-marketing-integration.md)
(Draft, Michael Zinn) covers exactly this, and **`Submitted Okendo Survey` is a named row
in its §4 trigger table**. The dependency chain:

| phase | what it does | status |
|---|---|---|
| 1 — connect + loyalty balance | `OkendoMarketing` integration record (own `kind`), API-key card, credential probe | **partly built**, branch `michaelzinn/okendo-marketing-auth`, gated OFF by `OKENDO_MARKETING_INTEGRATION` |
| 3 — marketing triggers | subscribe Okendo webhooks → map each to a custom event via the public endpoint | not started |
| 4 — quiz & survey | **`Submitted Okendo Survey`** + `Submitted Okendo Quiz` with NPS/quiz payloads | not started |

So both Piperblue flows are blocked on the same thing: **Phase 4**, which needs Phase 1
shipped and Phase 3's webhook→custom-event bridge. The transport already exists —
`POST /custom-events` on `redo/public/v2/server`, schema in
[`create-custom-event.ts`](https://github.com/redoapp/redo/blob/main/redo/public/common/src/custom-events/create-custom-event.ts)
(v2.3, `eventName` + `customer{id|email|phoneNumber}` + flat segmentable `data`, snake_case
v2.2 aliases still accepted). Okendo's `survey_response.*` webhook is the missing producer.

Two concrete things to raise with whoever picks this up:

1. **The event name must match verbatim.** Redo matches on
   `triggerStep.eventName === schemaInstance.eventName` with no normalization, so the
   producer must emit the string `Submitted Okendo Survey` — which is what the design doc
   already says, and what mime writes. Worth confirming it doesn't drift to
   `okendo_survey_submitted` or similar during implementation.
2. **The planned payload can't satisfy Piperblue's filter.** This flow's Klaviyo
   `trigger_filter` is *"Survey Name equals Customer Survey"*, and the design doc's `data`
   props for this event are `surveyId, npsScore, npsCategory` — **no survey name**. Redo's
   `triggerSpecificFields.conditions` is the right home for the filter, but there'd be
   nothing to key on. Either add a `surveyName` prop to the event, or the merchant accepts
   the flow firing on *every* Okendo survey. Until then the condition is left unset, which
   is the wider of the two behaviors.

Set `uniqueId` to the Okendo event id (the design doc already calls for this) so webhook
re-delivery doesn't re-trigger the flow.

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

- ~~**Okendo event source**~~ — closed. Not a mime question at all: it's Phase 4 of
  [`okendo-marketing-integration.md`](https://github.com/redoapp/redo/blob/main/docs/design/okendo-marketing-integration.md),
  which already names `Submitted Okendo Survey`. Flow imported and waiting. The one
  substantive gap found is that the planned event payload carries no survey *name*, so
  Piperblue's trigger filter has nothing to key on — see the `S6ghDv` section.
- ~~**Sj5GSG's dropped SMS**~~ — closed. Michael's call: recreate as a dedicated SMS flow.
  Imported as `6a7a5b6e54eff5fba6cc71c6`.
- **AI transformations should be done by the agent, not an API key** *(Michael,
  2026-08-10)*. Today `skipAi` is inferred from an unset `ANTHROPIC_API_KEY`, so imports
  silently skip image-as-button conversion, coupon rewrites, and font normalization with
  no signal. The decision is not "remember to set the key" — it's to **audit what the AI
  pass would have changed and have the agent perform those edits directly**, then drop the
  in-process LLM dependency. Two consequences for this plan: `skipAi` must appear in the
  run manifest rather than being inferred, and S4/S6 become agent-executed passes rather
  than API-backed ones.
- **Repo boundary** — mime is `MCHammer-12/mime` (personal), internal-tools is
  `redoapp/` (org). S7 either ports mime in or has internal-tools wrap it. Deferred
  until a real run tells us how much of mime the surface actually needs.
- **Credential handling** — merchant Klaviyo keys and Redo JWTs are per-run inputs. Once
  this runs from internal-tools rather than a local shell, they need somewhere real to
  live. Not urgent while local; blocking before S7.

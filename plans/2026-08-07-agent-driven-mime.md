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

**Model revised (2026-08-20, after Michael/Matt conversation):**
- **Distribution** — Tobot 2.0 becomes a **shared git repo each Redo operator runs
  locally**, not a Replit app. The agency never runs it; they get a shared Notion doc
  as the feedback surface, and that feedback enters a run the same way a call
  transcript does (S2).
- **This collapses S7.** The MCP server existed to bridge a gap that no longer exists:
  the tool lived on Replit, away from the agent. Local repo + Claude Code means the
  agent already has the code, the shell, and the filesystem. What survives of S7 is the
  **skills** door (judgment, shared team-wide via `.agents/skills/`) — the engine door
  does not need building. Revisit only if a non-Claude-Code caller appears.
- **Credentials** — merchant Klaviyo keys likely resolve from **Beacon** rather than
  per-run env. Unverified; see Open questions.
- **The loop is self-optimizing (S8).** Every ambiguity Claude resolves with a human is
  written back into the deterministic code, so the next merchant never asks it again.
  This is the point of the whole design, and it is new — see S8.

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

### S8 — Write-back loop *(the self-optimizing part)*

A resolved question must not stay resolved only for this merchant. Each one closes
twice: **import it**, then **teach the deterministic code**, so coverage ratchets up and
`needs_input` volume trends down without anyone maintaining a backlog.

**The rule that keeps this from poisoning the codebase.** Two things look identical at
the moment of asking and must never be written back the same way:

| | Example | Where it goes |
|---|---|---|
| **Mapping** — a Klaviyo construct → Redo construct fact, true for every merchant | `{% unsubscribe %}` → `FOOTER` block; Klaviyo segment trigger → gate step | **the code**, plus a smoke case |
| **Merchant fact** — true for this store only | which Redo segment mirrors the Klaviyo one; discount prefix `RE`; store id | **the run manifest**, never the code |

Getting this backwards is the main way the design fails: one merchant's specifics
harden into everyone's parser. Note this is a *different* axis from
`mechanical | merchant_visible` — that one decides whether to **ask**, this one decides
whether to **write back**.

**Definition of done for a write-back:** the mapping lands in a keyed registry (not a
`switch` — five operators committing mappings from local clones will conflict on a
switch and won't on a keyed literal), *and* a `*.smoke.ts` case pins it. The repo
convention already supports this; `EVENT_KEY_OVERRIDES` in
[`src/transform.ts`](../src/transform.ts) is roughly the right shape to generalize.

**The scoreboard.** "99% of cases" is only a claim if it's counted. The manifest records
per item whether it was `auto | agent_resolved | human_asked`; the trend in
`human_asked` across merchants is the measurement, and it falls out of the S1 result
contract for free.

**Precedent — the loop already ran three times (2026-08-12 → 08-20, Relay Goods):**
- ✅ custom_event templates 400'd on unavailable variables → resolved with Michael, written
  back as the FOOTER block + view-in-browser drop (`711e482`). Mapping.
- ✅ Klaviyo segment trigger has no Redo equivalent that names a segment → written back as
  the `SEGMENT_ID` gate (`49704b5`), with the segment id kept as a per-run **input**.
  Correct split: mechanism to code, merchant fact to manifest.
- ❌ An untranslatable Klaviyo profile-property filter emitted an **empty** inline-segment
  condition, which Redo evaluates as vacuously true — silently taking the wrong branch and
  killing a downstream email with no error. Patched in the merchant's data, **not** in the
  code. Still open, and it is the dangerous class: wrong output, no warning. Highest-value
  first write-back.

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

All imports ran with **AI transformations skipped** (`ANTHROPIC_API_KEY` unset in the
run shell → `skipAi`). Audited afterwards — see *The AI audit* below. Nothing was lost
to `skipAi`; two parser bugs were lost to instead.

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

### The AI audit — what `skipAi` actually cost *(nothing; the parser cost 5 blocks)*

Michael's instruction was to audit what the AI would have changed and do it by hand,
rather than reach for an API key. The audit turned up something better than a rewrite.

mime has exactly **one** AI-guarded transformation: `rewriteInlineCoupon`
([`src/ai-rewrite.ts`](../src/ai-rewrite.ts)), called from
[`transform.ts:116`](../src/transform.ts) for TEXT blocks where `hasInlineCoupon()` is
true. Image-as-button conversion and font normalization are recorded as planned work,
not shipped code paths — no AI runs on either today.

Across the 30 templates behind Piperblue's three flows, **4 contain `{% coupon_code %}`**,
all in `Sj5GSG`, all the same code (`Welcome_Series_Email`). **None of them is an inline
coupon.** All four are Klaviyo's dedicated **Coupon block** (`td.kl-coupon`) — a dotted
pill whose only content is the tag. So `rewriteInlineCoupon` would never have fired on a
single one, with or without a key. *`skipAi` cost this migration nothing.*

What it did cost was two silent drops, both now fixed
([`2c37ed2`](../src/parser/index.ts)):

1. **`kl-coupon` had no parser.** The wrapper carries no `kl-text`, so it reached neither
   `tryParseDiscountFromText` nor the AI pass — it fell through the dispatcher to
   *"Unknown block"* and the code vanished from the email. Now parsed into a Redo
   `DiscountBlock` carrying the `<a>`'s font/weight/size/color and the pill's background.
   The dotted border and the `<a href>` have no slot in `DiscountBlock`; they're named in
   a warning rather than dropped quietly.
2. **The section walker only visited wrappers under `kl-row > kl-column`.** Klaviyo
   occasionally hangs a `component-wrapper` straight off a `kl-section`; those blocks were
   dropped with **no warning at all**. Extracted the per-wrapper dispatch into
   `parseWrapper` and walk strays in document order alongside the rows. Rare — 1 of 30
   templates — but it was eating real copy.

Regression across all 30: **26 byte-identical**, and the 4 that change are exactly the 4
carrying a coupon.

**The four live templates were repaired in place**, not re-imported — `updateEmailTemplate`
`{emailTemplateId, updates}` with the recovered blocks spliced in by LCS, so every existing
block and `blockId` is untouched. Read back after write:

| Klaviyo | Redo template | subject | recovered |
|---|---|---|---|
| `QRviCU` | `6a7a52921b92fe5534c17af1` | Welcome to PiperBlue Makeup | discount @11 |
| `X3XvJf` | `6a7a52932d19417fd800d45e` | A note from Jamie | discount @7, **text @8** |
| `UrUPTT` | `6a7a529410daea3bd90759bf` | The skincare that changed my skin | discount @11 |
| `TaccT8` | `6a7a529520ee9864b5e7fded` | Making your morning easier | discount @13 |

`X3XvJf`'s recovered text is the email's closing paragraph — *"Thank you for letting us
share our love for pure, high-performance beauty with you…"* — which had been missing
outright from the imported email.

The four discount blocks carry **no `discountId`**. That is the parked discount-codes
question, and it stays parked: the block is the right destination, attaching a real code
is the post-import second pass.

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
- ~~**AI transformations should be done by the agent, not an API key**~~ — *(Michael,
  2026-08-10)*. Audited on Piperblue: the AI pass would have changed **nothing** (see
  *The AI audit*), and the real damage was two parser bugs `skipAi` had nothing to do
  with. Standing consequences for this plan:
  - `skipAi` must appear in the run manifest rather than being inferred from an unset
    `ANTHROPIC_API_KEY` — a silently-skipped pass is exactly how this went unnoticed.
  - The handoff mechanism already exists: `AI_VIA_CLAUDE_CODE=1`
    ([`src/ai-claude-code.ts`](../src/ai-claude-code.ts)) writes
    `.ai-cache/<id>.request.md` and polls for `.ai-cache/<id>.response.md`. That is the
    agent-executes-it path; it needs wiring into the run loop, not building.
  - **An "Unknown block" warning is a coverage gap, not noise.** Both bugs were visible
    in warnings nobody read — one of them emitted no warning at all. The run manifest
    should surface unknown/dropped blocks as a first-class result, not a log line.
- ~~**Repo boundary**~~ — closed *(2026-08-20)*. Stays a standalone shared repo that
  operators clone and run locally; no port into internal-tools, no MCP server. Skills
  are the only piece that ships through `.agents/skills/`.
- **Credential handling** — Michael expects merchant Klaviyo keys to live in **Beacon**.
  Unverified: whether Beacon exposes a read path an operator's local run can call, and
  whether Redo JWTs belong there too or stay minted per-run via jwt-bandit. Answer before
  the repo goes multi-operator — today keys are pasted into a shell, and merchant keys
  have leaked into transcripts once already this year.
- **Feedback surface** — a shared Notion doc is the agency's channel. Open: who converts
  a Notion entry into a run, and whether the resolution log lives in Notion (visible to
  the agency) or in the repo next to the mapping (where it becomes a test case). These
  want different homes; probably both, with the repo as source of truth.

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

### S0 — Spike: signup-form target *(blocking for S5)*
Both halves turned out to already exist; the open question is which Redo surface to aim at.

- **Klaviyo side — confirmed available.** `GET /api/forms/{id}` returns the encoded form
  definition; `POST /api/forms` creates. Scope `forms:read`. Rate limit 3/s burst,
  60/m steady. Documented workflow is GET → strip all `id`, `created_at`, `updated_at` →
  modify → POST. That is a clean read path, better than assumed.
- **Redo side — exists.** `redo/marketing/common/src/signup-form/signup-form-schema.ts`,
  `signup-form.ts` (`LayoutType.POPUP` / `FULLSCREEN`), Mongoose `SignupForm.ts`,
  `signup-form-repo.ts`, `get-signup-form.ts`. Signup forms are **not** a Redo gap.
- **The actual open question:** `redo/marketing/common/src/signup-form-to-spotlight-migration.ts`
  and `redo/marketing/manage/src/migrate-signup-forms-to-spotlights.ts` show an in-flight
  migration from SignupForm → **Spotlight**. Building an importer against SignupForm may
  target a deprecating surface.
- **Also unconfirmed:** no `createSignupForm` RPC surfaced in the marketing RPC search.
  Flows have `createAdvancedFlow`; forms may be repo-only (no merchant-facing create),
  which would mean the same redoapp-side ask as discount codes.

→ **Output:** a one-paragraph answer to "SignupForm or Spotlight, and is there a
create RPC" — sourced from the marketing team, not inferred. Everything else in S5
depends on it.

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

### S5 — Signup forms *(gated on S0)*
Net-new. Shape depends entirely on S0's answer. If there is no create RPC this becomes a
redoapp-side ask and drops to S6's category.

### S6 — Discount codes *(not a build — an ask)*
Per `project_discount_codes_open_question`, the Klaviyo coupon → Redo discount block path
likely needs a redoapp-side change to create and attach a code at import time. This is
blocked on someone else's roadmap. Correct action now is to write the ask and get it
queued, in parallel with S1–S4 — not to sequence build work behind it.

### S7 — MCP packaging
Only after a full merchant migration has run agent-driven. Split by door:
- **Skills** (`.agents/skills/`) — the judgment: how to read a transcript into a manifest,
  how to resolve a trigger question, how to pick a font substitution.
- **MCP server** (`apps/` or `mcp/`) — the engine: parse, render, import primitives.

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

- **S0** — SignupForm vs Spotlight; create-RPC existence. Blocks S5.
- **Repo boundary** — mime is `MCHammer-12/mime` (personal), internal-tools is
  `redoapp/` (org). S7 either ports mime in or has internal-tools wrap it. Deferred
  until a real run tells us how much of mime the surface actually needs.
- **Credential handling** — merchant Klaviyo keys and Redo JWTs are per-run inputs. Once
  this runs from internal-tools rather than a local shell, they need somewhere real to
  live. Not urgent while local; blocking before S7.

# Operator quickstart

mime brings a merchant's Klaviyo flows and email templates into Redo. You run it
locally, from this repo, with Claude Code driving it. Claude runs the commands
and resolves what the deterministic code can't map; you approve anything a
merchant would notice.

Everything imports **inactive** in Redo. Nothing you run here can send an email.

The phase-by-phase run loop — including the QA pass that produces most of the
accuracy — is in [HYBRID-RUN.md](HYBRID-RUN.md).

---

## One-time setup (~15 min)

**1. Get access.** Ask Michael for collaborator access on two private repos:
`MCHammer-12/mime` and `MCHammer-12/jwt-bandit`.

**2. Clone and install.**

```bash
git clone https://github.com/MCHammer-12/mime.git ~/code/mime && cd ~/code/mime && npm install
```

Node 20+ required.

**3. Install jwt-bandit** — mints a Redo merchant session token for any team, so
you never copy JWTs out of a browser.

```bash
git clone https://github.com/MCHammer-12/jwt-bandit.git ~/code/jwt-bandit && cd ~/code/jwt-bandit && npm link
```

**4. Store your Redo admin token.** On an authenticated `admin.getredo.com`
session: DevTools → Network → click any request to `admin-server.getredo.com` →
copy the `Authorization` header value **after** `Bearer ` (token only). Then:

```bash
jwt-bandit setup
```

It reads the clipboard, validates the token is complete, stores it in your macOS
Keychain, and test-mints so you know it worked. Prints `✅ admin token works`.

The admin token expires about every 30 days — re-run `jwt-bandit setup` when a
mint 401s. It is **org-wide root**: it can mint a session for any merchant. Treat
it like a production password. Never put it in a file, a dotfile, git, or Slack.

---

## Per-merchant run

**What you need before starting:**

- The merchant's Klaviyo private API key (`pk_…`) — from the merchant, or Beacon
- The Redo team id — the 24-hex id in the merchant's Redo URL (`/stores/<id>`)
- The list of flows and templates to bring over — usually from the call transcript

**Then just tell Claude, in this repo:**

> Bring over these flows for `<merchant>`: `<names>`. Klaviyo key `pk_…`, Redo
> team `<24-hex id>`.

Claude does the rest — lists the flows, matches names to Klaviyo ids, diagnoses
each one, imports, and reports what landed and what didn't.

### What Claude is actually running

For reference, or if you want to run one by hand.

```bash
# mint a merchant JWT (30 days)
REDO_JWT="$(jwt-bandit <teamId> 2>/dev/null)"

# dry run — parses, warns, writes nothing
KLAVIYO_API_KEY=pk_... REDO_JWT="$REDO_JWT" FLOW_ID=<klaviyoFlowId> \
  DIAGNOSE_ONLY=1 SKIP_AI=1 npx tsx src/flow/import-one.ts

# real import — same command, drop DIAGNOSE_ONLY
KLAVIYO_API_KEY=pk_... REDO_JWT="$REDO_JWT" FLOW_ID=<klaviyoFlowId> \
  SKIP_AI=1 npx tsx src/flow/import-one.ts

# a standalone template (not attached to a flow)
KLAVIYO_API_KEY=pk_... REDO_JWT="$REDO_JWT" TEMPLATE_ID=<klaviyoTemplateId> \
  SKIP_AI=1 npx tsx src/flow/import-template-one.ts
```

`SKIP_AI=1` is the default posture — Claude does the judgement calls itself
instead of a separate AI pass, so the reasoning is visible and reviewable.

**Always diagnose before you import.** The dry run surfaces every gap while
nothing has been written to the merchant's Redo account yet.

---

## When the tool stops

Three guards deliberately halt a run. Each means something different.

**1. `Refusing to run: this clone is N commit(s) behind origin/main`**

Someone fixed a mapping you don't have yet. Running anyway would re-import a bug
that's already solved, and would re-learn a mapping that's already in the code.

```bash
git pull
```

Then re-run. (`SKIP_VERSION_CHECK=1` overrides — don't, unless you're offline.)

**2. `Refusing to import: N condition step(s) carry no translatable filter`**

A branch in the flow uses a Klaviyo filter mime can't express in Redo. Imported
as-is, that branch would match **no** customer and always take the false path —
the true branch would never run. The flow would look imported and behave
differently, silently. That's worse than not importing it.

Fix the mapping (Claude will propose one), or import as-is on purpose with
`ALLOW_VACUOUS_CONDITIONS=1` and hand the merchant a note about the branch.

**3. `requires-review: …` warnings**

Not a stop — the run continues. Something mapped approximately or got dropped.
Read them; they're what goes in the merchant report.

---

## The write-back rule

This is the part that makes the tool get better instead of staying at 90%.

When Claude figures out how to map something the code didn't know — a trigger, a
metric, a font, a condition — that mapping goes **into the code**, not just into
this one import. Next merchant, it happens automatically with no intervention.

So: when Claude proposes a code change after resolving a mapping, approve it and
let it commit and push. Anyone on the team can approve. Skipping this is how five
people end up solving the same problem five times.

Merchant-specific facts (a store's discount prefix, their org name) go in the run
notes instead — those aren't mappings.

---

## Rules

- **Never commit merchant data or credentials.** `migrations/` is gitignored;
  keep merchant output there. Keys and JWTs go in the environment, never a file.
- **Everything lands inactive.** Review in Redo before anyone turns a flow on.
- **Ask before anything a merchant would notice.** Mechanical choices are yours;
  anything that changes what a customer receives is a conversation.
- **One person per store at a time.** Check for an existing import in the Redo
  account before you start — re-running creates duplicate flows, not updates.

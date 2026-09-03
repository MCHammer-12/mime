# Operator quickstart

mime brings a merchant's Klaviyo flows and email templates into Redo. You run it
locally, from this repo, with Claude Code driving it.

You give three things and read one report. In between, Claude runs the commands,
resolves what the deterministic code can't map, and decides the merchant-visible
calls itself — it reports them, it doesn't ask.

Everything imports **inactive** in Redo. Nothing you run here can send an email.

The phase-by-phase run loop — including the QA pass that produces most of the
accuracy — is in [HYBRID-RUN.md](HYBRID-RUN.md).

---

## One-time setup (~15 min)

**1. Get access.** Ask Michael for collaborator access on `MCHammer-12/mime`.
(`MCHammer-12/jwt-bandit` is public — no access needed.)

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
- **The store's name in Redo** — the name, not an id
- The list of flows to bring over — usually from the call transcript

**Then just tell Claude, in this repo:**

> Migrate `<store name>`. Klaviyo key `pk_…`. Bring over these flows: `<names>`.
>
> Run the whole loop in docs/HYBRID-RUN.md end to end. Don't stop to ask me about
> merchant-visible choices — decide them, and put every decision in the report.

Claude resolves the name to a team id, mints a JWT, lists the Klaviyo flows,
matches names to ids, diagnoses each one, imports, QAs the store, writes what it
learned back into the code, and hands you a report.

### What Claude is actually running

For reference, or if you want to run one by hand.

```bash
# store name -> team id + a minted JWT (accepts a 24-hex id too)
npx tsx src/flow/resolve-store.ts "Bailey's Blossoms"
REDO_JWT="$(jwt-bandit <teamId> 2>/dev/null)"

# dry run — parses, warns, writes nothing
KLAVIYO_API_KEY=pk_... REDO_JWT="$REDO_JWT" FLOW_ID=<klaviyoFlowId> \
  DIAGNOSE_ONLY=1 SKIP_AI=1 npx tsx src/flow/import-one.ts

# real import — same command, drop DIAGNOSE_ONLY
KLAVIYO_API_KEY=pk_... REDO_JWT="$REDO_JWT" FLOW_ID=<klaviyoFlowId> \
  SKIP_AI=1 npx tsx src/flow/import-one.ts

# QA the store — renders every template and checks absolute invariants
REDO_JWT="$REDO_JWT" FLOW_FILTER="<name fragment>" QA_JSON=/tmp/qa.json \
  npx tsx src/flow/qa-store.ts

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

Three guards halt a run. Claude clears the first two itself; only the third is
about you.

**1. `Refusing to run: this clone is N commit(s) behind origin/main`**

Someone fixed a mapping you don't have yet. Running anyway would re-import a bug
that's already solved, and would re-learn a mapping that's already in the code.
Claude pulls and re-runs. (`SKIP_VERSION_CHECK=1` overrides — don't, unless
you're offline.)

**2. `Refusing to import: N condition step(s) carry no translatable filter`**

A branch in the flow uses a Klaviyo filter mime can't express in Redo. Imported
as-is, that branch would match **no** customer and always take the false path —
the true branch would never run. The flow would look imported and behave
differently, silently.

Claude works the mapping out and puts it in the code. If nothing maps, it imports
on purpose with `ALLOW_VACUOUS_CONDITIONS=1` and the branch goes in the report as
a known issue. Either way the run continues.

**3. `"<name>" matches N stores` from resolve-store**

This one is yours. The store name is ambiguous, and writing flows into the wrong
merchant's account is the one mistake here that can't be undone from outside.
Re-run with the full name or the team id.

`requires-review: …` warnings are not a stop — they're what goes in the report.

---

## The write-back rule

This is the part that makes the tool get better instead of staying at 90%.

When Claude figures out how to map something the code didn't know — a trigger, a
metric, a font, a condition — that mapping goes **into the code**, not just into
this one import, and gets committed and pushed in the same run. Next merchant, it
happens automatically. Skipping this is how five people end up solving the same
problem five times.

The report lists every code change with its commit, so you can read what changed
after the fact and revert anything you disagree with.

Merchant-specific facts (a store's discount prefix, their org name) go in the run
notes instead — those aren't mappings.

---

## Rules

- **Never commit merchant data or credentials.** `migrations/` is gitignored;
  keep merchant output there. Keys and JWTs go in the environment, never a file.
- **Everything lands inactive.** This is the whole safety net for an unattended
  run — read the report before anyone turns a flow on.
- **Claude decides, then reports.** Merchant-visible calls are made during the
  run and listed in the report with the option that was rejected. Overrule them
  there, before activation.
- **One person per store at a time.** Check for an existing import in the Redo
  account before you start — re-running creates duplicate flows, not updates.

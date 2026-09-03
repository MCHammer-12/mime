# Onboarding a new operator

Who this is for: Redo SEs running Klaviyo → Redo migrations locally with Claude Code.
Current roster: Bailey Kealamakia, Milo Atwood, Austin Napierski.

---

## 1. What Michael does first (once per person)

Usually nothing. Both `MCHammer-12/mime` and `MCHammer-12/jwt-bandit` are public.
The only prerequisite is Redo access, and which one depends on the token path:

| Path | Needs | Good for |
|---|---|---|
| **A — jwt-bandit** (recommended) | a **Redo admin account** on `admin.getredo.com` | anyone running this more than once — resolves a store by name and mints its own session for any team |
| **B — paste a JWT** | browser access to the merchant's own Redo store | a one-off run, or before an admin account exists |

Path A is worth the extra five minutes of setup. On path B the operator re-copies
a token out of DevTools for every store, and every token expires.

> The admin token path A stores is **org-wide root** — it can mint a merchant
> session for any team. One per person, in their own Keychain, never shared, never
> pasted into chat.

---

## 2. Paste this into Claude Code (the operator, once)

Open Claude Code in `~/code` (or wherever you keep repos) and paste one block.

### Path A — jwt-bandit

```
Set me up to run mime (the Klaviyo → Redo migration tool). Work through this in order and
stop at any step that needs me.

1. Check I have node >= 20. If not, tell me and stop.
2. Clone https://github.com/MCHammer-12/mime.git and https://github.com/MCHammer-12/jwt-bandit.git
   into the current directory. Both are public.
3. In mime/: run `npm install`.
4. In jwt-bandit/: run `npm link` so `jwt-bandit` is on my PATH. Verify with `which jwt-bandit`.
5. Stop and tell me to get my Redo admin token: on an authenticated admin.getredo.com session,
   DevTools → Network → click any request to admin-server.getredo.com → copy the Authorization
   header value AFTER the word "Bearer" (token only). Tell me to copy it to my clipboard, then
   say "ready".
6. When I say ready, run `jwt-bandit setup`. It reads the clipboard, validates the token is
   complete, stores it in my macOS Keychain, and test-mints. Never print the admin token.
7. Verify end to end: mint a token for the Redo Guide team 69ebb4e46b786f172dc1909f and POST
   https://app-server.getredo.com/rpc/getAdvancedFlows with header `Authorization: <token>`
   (NO "Bearer" prefix — merchant RPCs reject it). Expect HTTP 200 and a list of flows.
   Report the flow count only. Never print either token.
8. From mime/, read CLAUDE.md, docs/ONBOARDING.md and docs/HYBRID-RUN.md so you know the rules,
   then tell me I'm set up and what to give you to start a migration.
```

### Path B — paste a JWT each run

No admin account, no Keychain, no jwt-bandit. Setup is one step shorter; every
run costs one DevTools copy.

```
Set me up to run mime (the Klaviyo → Redo migration tool). I don't have a Redo admin
account, so I'll paste a merchant JWT for each run instead of minting one.

1. Check I have node >= 20. If not, tell me and stop.
2. Clone https://github.com/MCHammer-12/mime.git into the current directory (it's public)
   and run `npm install` in it.
3. Stop and tell me to grab a merchant JWT: log into the merchant's store on app.getredo.com,
   DevTools → Network → click any request to app-server.getredo.com → copy the whole
   Authorization header value. It is a raw JWT with NO "Bearer" prefix. Tell me to paste it.
4. When I paste it, write it to a file outside the repo (chmod 600) and export REDO_JWT from
   that file — never echo it, never put it in a repo file. Decode its `aud` claim: it reads
   `mcht/<teamId>`, and that team id IS the store, so I don't need to give you a store name.
   Tell me which store it resolved to and confirm it's the right one.
5. Verify it works: POST https://app-server.getredo.com/rpc/getAdvancedFlows with header
   `Authorization: <the raw JWT>` and body {"input":{"getUsers":false,"includeMetrics":false,
   "includeOriginFlows":false}}. Expect HTTP 200. Report the flow count only.
6. From mime/, read CLAUDE.md, docs/ONBOARDING.md and docs/HYBRID-RUN.md so you know the rules,
   then tell me I'm set up and what to give you to start a migration.

For the rest of this session, skip src/flow/resolve-store.ts — it needs an admin token I don't
have. Use the team id from the JWT directly.
```

Tokens expire in about 30 days on path A and sooner on path B — when an RPC
starts returning 401, get a fresh one. It is never a bug in mime.

Expected time: 10 minutes on path A, 5 on path B — most of it waiting on `npm install`
and the DevTools copy.

If a step fails, say what failed and Claude will name the cause. The common ones:

| Symptom | Cause | Fix |
|---|---|---|
| `git clone` fails | Network or a typo — both repos are public, so it isn't access | Re-run the clone |
| `jwt-bandit: command not found` | `npm link` didn't run or PATH is stale | Re-run `npm link` in `jwt-bandit/`, open a new shell |
| Mint returns 401 | Admin token partial or expired (~30 day life) | Re-run `jwt-bandit setup` |
| `no admin token` from resolve-store | Path B — there is no admin token by design | Skip resolve-store; use the team id from the JWT's `aud` claim |
| RPC returns 401 with a fresh token | `Bearer ` prefix on a merchant RPC | Send the raw JWT, no prefix |

---

## 3. Running a migration

Give Claude three things:

1. **Merchant name** — so it can find the Redo store. On path B, paste the merchant
   JWT instead: it carries the team id in its `aud` claim, so the name is redundant
2. **Klaviyo private API key** — `pk_...` (read access is enough)
3. **The list of flows / templates to bring over** — names as they appear in Klaviyo

Example:

```
Migrate Piperblue Makeup. Klaviyo key pk_XXXX. Bring over these flows:
Welcome Series, Abandoned Checkout, Browse Abandonment, Post-Purchase Thank You.
```

That's the whole input. From there Claude will:

1. Confirm the clone is current with `origin/main` (it refuses to run from a stale clone)
2. Mint a merchant JWT for that store with `jwt-bandit`
3. Check what already exists in the Redo store, so nothing gets duplicated
4. Pull the flows from Klaviyo and match your names to Klaviyo ids
5. Diagnose each one before writing anything (`DIAGNOSE_ONLY=1`)
6. Import the ones that map cleanly
7. Report what landed, what didn't, and why

**Every imported flow lands disabled.** Nothing sends until a human turns it on.

That is the happy path. [HYBRID-RUN.md](HYBRID-RUN.md) covers the whole loop
phase by phase, including the post-import QA checklist — run it, it is where most
of the accuracy comes from.

---

## 4. What Claude decides on its own

It does not stop mid-run to ask you about merchant-visible choices. It decides them,
records the alternative it rejected, and puts both in the report:

- A trigger with no Redo equivalent
- A font that isn't in the brand kit
- A condition that can't be expressed in Redo's schema
- Anything else that changes what a customer receives

The safety net is that **everything lands inactive**. Nothing can send before you read
the report, and the report's "Decisions made without asking" section is where you
overrule anything you disagree with.

Two things genuinely stop a run, and both are input problems rather than judgement
calls: a store name that matches more than one Redo store, and a clone that's behind
`origin/main`.

Some things can't be decided by anyone in the run — a Redo-side schema change, a flow
that has to be rebuilt by hand, a discount code that has to be created on the Redo
side. Those get flagged in the report, not asked about.

---

## 5. The write-back loop

When Claude resolves a mapping the tool didn't know how to handle, it does two things:

1. Imports it for this merchant
2. **Changes mime's code so the next run handles it automatically**

That second part is the point. The change is committed and pushed in the same run, and
the report lists every one of them with its commit — read them after the fact and revert
anything you disagree with. Over time the tool needs you less.

Two rules that keep five clones converging instead of drifting:

- **Pull before you run.** The tool enforces this; don't work around it with `SKIP_VERSION_CHECK=1`.
- **Push what you learn.** A fix that stays on your machine helps nobody.

---

## 6. Never commit

- Klaviyo API keys, Redo JWTs, the admin token
- Anything under `migrations/` (gitignored — it holds merchant data)
- `.claude/settings.local.json` (gitignored — your personal permissions)

`.claude/settings.json` **is** committed. It's the shared permission allowlist so a run
doesn't stop for approval on every `npx tsx` and `curl`. You review the write-back loop
from the report's commit list after the run, not from a prompt during it.

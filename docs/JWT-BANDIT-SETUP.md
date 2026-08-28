# jwt-bandit — for a new teammate

Two parts. Part 2 (the paste-in prompt) is the one-time setup and has to run
first; Part 1 is what you do with it every day after.

Prereqs: macOS, Node 18+, and a working `admin.getredo.com` login. The repo is
public, so no GitHub access request is needed.

---

## Part 1 — how to use it

### What it does

`jwt-bandit <teamId>` prints a live Redo **merchant session JWT** for that team.
It's the same token you'd get by clicking "Merchant Dashboard" in the admin
dashboard and digging it out of localStorage — except it's one command, and the
token is usable from the terminal (curl, scripts, Claude), which the browser
path won't give you.

You need it any time you want to hit `app-server.getredo.com` as a merchant:
reading their flows, templates, segments, or making changes via RPC instead of
clicking through the UI.

### The one command

```bash
jwt-bandit 6697f3be9e2ead72ab1c2359
```

Merchant token goes to stdout. Diagnostics (which team, both tokens' expiry) go
to stderr, so redirecting stderr gives you just the token:

```bash
TOKEN="$(jwt-bandit 6697f3be9e2ead72ab1c2359 2>/dev/null)"
```

The teamId is the 24-hex id in a Redo admin URL — `/stores/<id>`. Same thing
`team` means in the code.

### Using the token

Merchant RPC calls use the **raw token with no `Bearer` prefix**. This trips
everyone up once:

```bash
curl -sS -X POST 'https://app-server.getredo.com/rpc/getAdvancedFlows' \
  -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"input":{"getUsers":false,"includeMetrics":false,"includeOriginFlows":false}}'
```

(Admin calls to `admin-server.getredo.com` DO use `Bearer`. Merchant calls
don't.)

Some other endpoints you'll reach for:

| Endpoint | Input |
| --- | --- |
| `/rpc/getAdvancedFlows` | `{"input":{"getUsers":false,"includeMetrics":false,"includeOriginFlows":false}}` |
| `/marketing-rpc/getEmailTemplates` | `{"input":{}}` — returns a flat array |
| `/marketing-rpc/updateEmailTemplate` | `{"input":{"emailTemplateId":"…","updates":{…}}}` |

### Working with Claude

You don't have to run it yourself. Once it's set up, tell Claude "mint a token
for team `<id>` with jwt-bandit and pull their flows" and it'll do the whole
chain. The token stays in the shell — it never has to land in the transcript.

### Refresh

- **Merchant tokens last ~30 days.** Don't save them. Minting is instant, so
  just mint fresh each time.
- **Your admin token also lasts ~30 days.** That's the one thing to maintain.
  When a mint returns 401, copy a fresh admin token (same DevTools steps as
  setup) and re-run `jwt-bandit setup`. Every run prints your admin token's
  expiry so you can see it coming.

### Rules

The admin token is org-wide root — it can mint a session as **any** Redo
merchant. Treat it like a production password. It lives encrypted in your
Keychain; never put it in a dotfile, a repo, a Slack message, or a Claude
transcript. Same for minted merchant tokens: full merchant impersonation for a
month, so don't log or commit them either.

---

## Part 2 — paste this into Claude Code

One-time setup. Open a fresh Claude Code session on your Mac and paste
everything below.

```
Set up `jwt-bandit` on my Mac. It's a CLI that mints a Redo merchant session JWT
for any team by calling the admin API, so I don't have to dig tokens out of
localStorage. Repo: https://github.com/MCHammer-12/jwt-bandit

Do these in order and stop at the first failure:

1. Check `node --version` is 18 or higher. If not, tell me and stop.
2. `git clone https://github.com/MCHammer-12/jwt-bandit.git ~/code/jwt-bandit`
   (if `~/code` doesn't exist, create it first). It's a public repo, so no auth
   needed.
3. `cd ~/code/jwt-bandit && npm link` so `jwt-bandit` is on my PATH. If npm link
   fails on permissions, don't sudo — set up a shell alias to
   `node ~/code/jwt-bandit/mint.mjs` instead and tell me.
4. Read the README so you know how the tool works, then stop and tell me to do
   this by hand:
     - open an authenticated admin.getredo.com tab
     - DevTools > Network > click any request to admin-server.getredo.com
     - copy the Authorization header value AFTER the word "Bearer" (token only)
     - say "copied" when it's on my clipboard
5. Once I say copied, run `jwt-bandit setup`. It reads my clipboard itself,
   validates the token is a complete admin JWT, stores it in the macOS Keychain
   under service `redo-admin-jwt`, and test-mints to prove it works. Report the
   pass/fail line it prints and the token's expiry date.

Hard rules for you while doing this:
- The admin token is org-wide root — it can mint a session as ANY merchant.
  Never print it, echo it, log it, write it to a file, or ask me to paste it
  into chat. `jwt-bandit setup` reads the clipboard directly; that is the only
  path the token takes.
- Don't `cat` or `security find-generic-password` the stored token to "verify"
  it. `setup` already verifies by minting.
- Don't commit anything to this repo.

That's the whole job. Don't install anything else.
```

Success looks like: `setup: ✅ admin token works — you're ready.`

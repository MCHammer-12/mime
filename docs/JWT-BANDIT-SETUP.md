# jwt-bandit setup — paste-in prompt

Give this to a teammate. They paste the block below into a fresh Claude Code
session on their Mac. Setup only — no mime, no migration tooling.

Prereq (Michael's action): add them to `MCHammer-12/jwt-bandit` on GitHub.
Prereq (theirs): a working `admin.getredo.com` login.

---

Set up `jwt-bandit` on my Mac. It's a CLI that mints a Redo merchant session JWT
for any team by calling the admin API, so I don't have to dig tokens out of
localStorage. Repo: https://github.com/MCHammer-12/jwt-bandit

Do these in order and stop at the first failure:

1. Check `node --version` is 18 or higher. If not, tell me and stop.
2. `git clone https://github.com/MCHammer-12/jwt-bandit.git ~/code/jwt-bandit`
   (if `~/code` doesn't exist, create it first). If the clone 404s or asks for
   credentials, stop — I need to be added to the repo.
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

---

## Using it afterward

```bash
jwt-bandit <24-hex-teamId>          # merchant JWT -> stdout, diagnostics -> stderr
TOKEN="$(jwt-bandit <teamId> 2>/dev/null)"
```

Merchant RPC calls use the raw token with **no** `Bearer` prefix:

```bash
curl -sS -X POST 'https://app-server.getredo.com/rpc/getAdvancedFlows' \
  -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"input":{"getUsers":false,"includeMetrics":false,"includeOriginFlows":false}}'
```

Admin token expires ~30 days. When a mint 401s, re-copy a fresh admin token and
re-run `jwt-bandit setup`.

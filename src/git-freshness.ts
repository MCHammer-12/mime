// Five operators run this tool from five local clones. A clone that is behind
// origin/main re-runs bugs the loop already fixed and, worse, re-learns
// mappings that are already in the code — so the write-back loop stops
// converging. Check before touching a merchant.
//
// The comparison is "does origin/main contain commits this clone doesn't",
// not "is HEAD == origin/main" — a feature branch built on top of main is fine.

import { execSync } from "node:child_process";

function git(args: string): string | null {
  try {
    return execSync(`git ${args}`, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  } catch {
    return null;
  }
}

export function assertUpToDate(): void {
  if (process.env.SKIP_VERSION_CHECK) return;
  if (git("rev-parse --git-dir") === null) return;

  if (git("fetch origin main --quiet") === null) {
    console.log(`      version check: can't reach origin — running this clone as-is`);
    return;
  }

  if (git("merge-base --is-ancestor origin/main HEAD") !== null) {
    console.log(`      version check: up to date with origin/main`);
    return;
  }

  // Replit's deploy checkpoints land on main as empty commits. Blocking on
  // those trains operators to set SKIP_VERSION_CHECK=1, which kills the guard.
  // Only behaviour-carrying commits count.
  const changed = git("diff --name-only HEAD...origin/main -- src package.json");
  if (!changed) {
    console.log(`      version check: behind origin/main, but nothing in src changed`);
    return;
  }

  const behind = git("rev-list --count HEAD..origin/main") ?? "?";
  const missing = git("log --oneline --no-decorate -5 HEAD..origin/main") ?? "";
  console.error(
    `\nRefusing to run: this clone is ${behind} commit(s) behind origin/main, so it ` +
      `may re-import bugs that are already fixed.\n\n${missing}\n\n` +
      `Run \`git pull\` (or rebase this branch on origin/main), then re-run. ` +
      `SKIP_VERSION_CHECK=1 overrides.`,
  );
  process.exit(1);
}

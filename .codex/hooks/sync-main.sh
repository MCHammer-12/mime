#!/bin/bash
# SessionEnd hook: if HEAD is on a claude/* branch with commits ahead of main
# that fast-forward cleanly, push the branch and FF-push main on origin.
# Silent no-op if tree is dirty, not on a claude/* branch, or FF isn't possible.

set -u

BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null) || exit 0
[[ "$BRANCH" == claude/* ]] || exit 0

if [ -n "$(git status --porcelain)" ]; then
  echo "[sync-main] $BRANCH has uncommitted changes, skipping" >&2
  exit 0
fi

git fetch origin main --quiet 2>/dev/null || {
  echo "[sync-main] fetch origin main failed, skipping" >&2
  exit 0
}

HEAD_SHA=$(git rev-parse HEAD)
MAIN_SHA=$(git rev-parse origin/main 2>/dev/null) || {
  echo "[sync-main] origin/main not found, skipping" >&2
  exit 0
}

if [ "$HEAD_SHA" = "$MAIN_SHA" ]; then
  exit 0
fi

if ! git merge-base --is-ancestor "$MAIN_SHA" "$HEAD_SHA"; then
  echo "[sync-main] $BRANCH diverged from main (not FF), skipping" >&2
  exit 0
fi

SHORT=$(git rev-parse --short HEAD)
AHEAD=$(git rev-list --count "$MAIN_SHA..$HEAD_SHA")

git push origin "$BRANCH" 2>&1 | sed 's/^/[sync-main] /' >&2

if git push origin "HEAD:refs/heads/main" 2>&1 | sed 's/^/[sync-main] /' >&2; then
  echo "[sync-main] FF origin/main -> $SHORT ($AHEAD commits from $BRANCH)" >&2
else
  echo "[sync-main] push to main failed" >&2
fi

exit 0

# Feedback workflow — planner/executor pattern

Use this when a batch of feedback / fixes is ≥5 distinct items, or when
multiple Claude sessions will work on the batch in parallel. For 2-3
items, just do them inline — the structure is overhead.

## Roles

- **Planner session (one):** reads all feedback, groups into atomic
  tasks (one task = one PR worth of change). For each task, does the
  discovery — reads files, finds root cause, names `file:line` pointers
  — so the executor doesn't re-pay that cost. Writes task files +
  `INDEX.md`. Does not edit code.
- **Executor sessions (one or more):** each one picks an `unclaimed`
  task from the INDEX, marks it `claimed`, reads only its task file +
  the files it names, makes the change on a fresh branch off `main`,
  opens the PR, marks `done`.

The planner is the source of truth for **what work exists** and **how to
do it**. The executor is the source of truth for **whether each piece is
finished**.

## Layout

```
plans/feedback/
├── README.md                          (this file)
└── <YYYY-MM-DD>-<short-name>/         one batch per directory
    ├── INDEX.md                       status board + ToC
    ├── <task-slug>.md                 one file per atomic task
    └── ...
```

`<short-name>` is the merchant or theme — `goumikids`, `flow-polish`,
`automations-feedback`. If two batches land the same day, suffix `-2`.

## Branch convention

Each task gets its own branch off `main`: `<type>/<task-slug>` where
`<type>` matches existing repo style (`fix`, `feat`, `refactor`,
`chore`, `docs`). The planner writes the exact branch name into the
task file so executors don't collide. Never pile multiple tasks onto
the same branch.

## Status lifecycle

Status lives in two places that must agree:

1. The `status:` field in the task file's frontmatter
2. The Status column in `INDEX.md`

Values:

- `unclaimed` — planner wrote it; nobody is on it
- `claimed` — an executor has started
- `done` — PR merged
- `blocked` — executor hit something it can't resolve; updates the
  task file's Notes section with what's blocking and surfaces to
  Michael
- `dropped` — Michael decided not to do it

## Executor responsibilities

On claim:
1. Edit the task file's frontmatter: `status: claimed`
2. Edit INDEX.md: flip that row's Status cell to `claimed`
3. Cut the branch: `git checkout main && git pull && git checkout -b <branch>`

On completion:
1. Open the PR (`gh pr create ...`)
2. Edit the task file: `status: done`, add `pr: <url>`, fill in the `## Done` section
3. Edit INDEX.md: flip Status to `done`, add the PR link in the PR column

## Don'ts (for executors)

- **Don't improvise** if the task description turns out to be wrong or
  the root cause differs from what the planner wrote. Update the task
  file's Notes section, mark `blocked`, surface to Michael.
- **Don't expand scope.** Every change must trace to the feedback in
  this task. Adjacent issues go in Notes — don't fix inline.
- **Don't `git pull` / rebase mid-task without asking.** Another
  executor's commit could land between your read and your edit.
- **Don't write to other tasks' files.** One task per executor.

## Coordination notes

- INDEX.md is shared-write. Anyone can edit any row, but use the `Edit`
  tool (not `Write`) so you only touch one cell at a time. If two
  executors edit different rows concurrently, both edits land cleanly.
- Michael assigns tasks explicitly when launching each executor
  ("work on task #3" or "pick the unclaimed image-padding task"). Don't
  rely on the file as a lock — there's no atomic claim. If two sessions
  both think they own a task, the second one to push will lose the
  race; Michael notices and resolves.
- The planner can add new tasks to an open batch. Just append to
  INDEX.md and write the new task file.

### Parallel-session git hygiene (lessons from the wild)

Both planner and executor sessions share the same working tree. The
two pitfalls below show up reliably when ≥2 sessions are active.

- **Stage explicitly, verify before commit.** Another session may have
  files staged but not yet committed. `git commit` will sweep those
  in. Steps:
  1. `git add <your-explicit-paths>` only — no `git add .` / `git add -A`
  2. `git diff --staged --stat` to confirm only your files are listed
  3. Commit
- **Pass `--head <branch> --base main` explicitly to `gh pr create`.**
  Parallel sessions can switch the working branch back to `main`
  between your commands. Without explicit flags, gh reads HEAD at
  execution time and errors with "head branch 'main' is the same as
  base branch 'main'". Always:
  ```bash
  gh pr create --head <your-branch> --base main --title "..." --body "..."
  ```

## Templates

### `INDEX.md`

```markdown
# <Batch name> — <YYYY-MM-DD>

Source: <Slack thread / troubleshoot bundle / merchant call — where the feedback came from>

## Tasks

| # | Status | Task | Branch | PR |
|---|--------|------|--------|----|
| 1 | unclaimed | [<title>](<slug>.md) | `fix/<slug>` | — |
| 2 | claimed | [<title>](<slug>.md) | `feat/<slug>` | — |
| 3 | done | [<title>](<slug>.md) | `fix/<slug>` | [#NN](https://github.com/MCHammer-12/mime/pull/NN) |

## Cross-cutting notes

<anything that applies to multiple tasks — shared root cause, file
that several tasks touch, sequencing constraints>
```

### Per-task file `<slug>.md`

```markdown
---
status: unclaimed
branch: fix/<slug>
pr: null
---

# <Title — short, specific>

## Feedback (verbatim)

> <paste the exact feedback — Slack message, bug report, etc>

## Root cause

<what the planner found. file:line pointers. Why it's happening, not just where.>

## Proposed change

<specific enough that a fresh-context Claude can execute it. Name files,
functions, the actual diff shape. If multiple approaches are viable,
pick one and explain why.>

## Verify

<how to confirm the fix works. Test path, smoke command, manual repro,
screenshot — whatever proves the feedback is addressed.>

## Notes

<anything the executor should know but isn't directly part of the change:
adjacent issues spotted during planning, prior art, gotchas, files the
planner considered touching but ruled out.>

## Done

<filled by executor on completion:
- PR link
- 1-line summary of what shipped
- Any deviations from the proposed change and why>
```

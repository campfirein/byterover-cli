---
name: byterover-vc
description: "Use when initializing, inspecting, branching, committing, merging, pulling, or pushing ByteRover context-tree changes with brv vc."
---

# ByteRover VC

`brv vc` is local version control for `.brv/context-tree`. It uses git-like commands for initializing, inspecting, staging, branching, merging, and syncing knowledge-base changes.

## When To Use VC

- The user asks to inspect, diff, commit, branch, merge, pull, or push context-tree changes.
- You need to check whether curated knowledge changed files.
- You need to prepare local context-tree changes for sync.
- The user asks about context-tree history.
- The user is starting a new project (`brv vc init`) or joining an existing space (`brv vc clone`).

Do not use destructive history commands unless the user explicitly asks.

## Quick Reference

### Setup

```bash
brv vc init                                 # initialize VC in current project
brv vc clone https://byterover.dev/<team>/<space>.git
brv vc config user.name "Your Name"         # required before first commit
brv vc config user.email "you@example.com"
brv vc config user.name                     # read current value (omit value)
```

### Inspect

```bash
brv vc status                               # working-tree + index state
brv vc diff                                 # unstaged changes
brv vc log                                  # commit history
brv vc remote                               # show origin URL
```

### Stage + commit

```bash
brv vc add .                                # stage all changes
brv vc add notes.md                         # stage a single file
brv vc commit -m "Document retry behavior"
```

### Branch + checkout

```bash
brv vc branch                               # list local branches
brv vc checkout feature/auth-rules          # switch to an existing branch
brv vc checkout -b feature/new-domain       # create + switch in one step
brv vc checkout --force main                # discard local changes and switch
```

### Sync with remote

```bash
brv vc fetch                                # fetch refs, no merge
brv vc fetch origin main                    # fetch a specific branch
brv vc pull                                 # fetch + merge tracked upstream
brv vc push                                 # push to tracked upstream
brv vc push -u                              # first push: set upstream
brv vc push origin feature/my-branch        # push to explicit target
```

### Merge

```bash
brv vc merge feature/my-branch              # merge into current branch
brv vc merge -m "Custom message" feature/x  # custom merge commit message
brv vc merge --continue                     # finish after resolving conflicts
brv vc merge --abort                        # roll back an in-progress merge
```

### Undo (ask first)

```bash
brv vc reset notes.md                       # unstage a single file
brv vc reset                                # unstage everything
brv vc reset --soft HEAD~1                  # undo last commit, keep changes staged
brv vc reset --hard HEAD~1                  # DESTRUCTIVE — discard commit + changes
```

## Local Workflow

1. **`brv vc status`** before changing VC state — confirms what's staged and what's dirty.
2. **`brv vc diff`** to inspect content before staging when the change is non-trivial.
3. **`brv vc add`** the files the user actually wants to commit; prefer explicit paths over `.` when only some changes belong in this commit.
4. **`brv vc commit -m "<short summary>"`** with a concise, descriptive message.
5. For changes the user wants to ship: run `brv vc log` after to confirm the commit, then `brv vc push` (or `brv vc push -u` on the first push of a new branch).

## Remote Workflow

- **First-time clone:** `brv vc clone <url>` creates a local copy. Run `brv vc config user.name` + `user.email` before the first commit if not already set globally.
- **Pulling teammate changes:** `brv vc pull` — fast-forwards or merges automatically; falls into conflict resolution if both sides changed the same topic.
- **Conflict handling:** when a pull or merge surfaces conflicts, open the listed files, resolve markers, `brv vc add` them, then `brv vc merge --continue`. Do NOT switch branches or run `reset` mid-merge.

Remote sync requires authentication. If `brv vc push` or `brv vc pull` fails with auth errors, direct the user to `brv login`.

## Safety

- `brv vc reset --hard` discards local changes irrevocably. Never run without explicit user confirmation and a clear target ref.
- `brv vc checkout --force` discards uncommitted changes. Same rule.
- `brv vc merge --abort` only rolls back an in-progress merge; it does NOT undo a completed merge — use `reset --hard <ref>` for that, with confirmation.
- Use `brv vc` commands for `.brv/context-tree` — never operate on its nested git with plain `git` commands.

## Common Mistakes

| Mistake | Correct behavior |
|---|---|
| Committing context-tree changes without inspection | Run `brv vc status` and `brv vc diff` first |
| Running `reset --hard` or `checkout --force` casually | Ask for explicit user direction; restate what will be lost |
| Forgetting `--set-upstream` on the first push of a new branch | Use `brv vc push -u` once per new branch |
| Assuming remote sync works without auth | Check login/auth errors; tell the user to `brv login` |
| Using repo `git` commands for `.brv/context-tree` history | Use `brv vc` commands for ByteRover context-tree state |
| Skipping `brv vc config user.name` / `user.email` before the first commit | Commits require author; set both before staging |
| Switching branches with uncommitted changes | Commit first (`brv vc add` + `commit`); avoid `--force` unless the user accepts the loss |

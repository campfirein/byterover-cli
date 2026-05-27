---
name: byterover-review
description: "Use when brv curate reports pending review, the user asks to inspect/approve/reject queued ByteRover operations, or the user asks to enable/disable the HITL review log."
---

# ByteRover Review

Some curate operations require human review before ByteRover applies them to `.brv/context-tree/`. Pending review means the knowledge is not stored yet. Review can also be toggled off project-wide if the user prefers auto-apply.

## When To Review

- `brv curate` reports pending review.
- The user asks to inspect pending context-tree operations.
- The user asks to approve or reject queued ByteRover changes.
- You need to verify whether a high-impact operation has been applied.
- The user asks to enable or disable the project's review log.

Do not approve, reject, or toggle review state without explicit user direction.

## Quick Reference

```bash
# Inspect / act on pending items
brv review pending --format json
brv review approve <taskId> --format json
brv review reject <taskId> --format json
brv review approve <taskId> --file architecture/auth.md --format json
brv review reject <taskId> --file architecture/auth.md --format json

# Toggle the project's HITL review log
brv review                                       # show current state (enabled / disabled)
brv review --disable                             # stop queueing review items + suppress prompts
brv review --enable                              # resume queueing review items
```

## Toggle The Review Log

`brv review` with no subcommand shows whether review is on or off. `--disable` stops `brv curate` from prompting for review on high-impact ops, suppresses per-op review markers in curate-log entries, and prevents `brv dream` from queueing review items. `--enable` reverses all of the above. Existing pending items are unaffected — they remain listed by `brv review pending` and can still be approved or rejected.

Confirm with the user before flipping the toggle: disabling silently auto-applies future high-impact curates, which is the opposite of HITL.

## Review Protocol

Run `brv review pending --format json` first. Summarize the task id, operation type, affected file paths, impact level, and before/after summaries for the user.

Approve only when the user asks you to apply the pending changes. Reject only when the user asks you to discard them.

Use `--file <path>` to approve or reject individual files when a task has multiple operations and the user chooses a subset.

## Stored-Knowledge Rule

Do not treat a pending high-impact operation as stored knowledge until it is approved and applied. If the user asks whether a curate succeeded, distinguish "queued for review" from "saved".

## Common Mistakes

| Mistake | Correct behavior |
|---|---|
| Saying pending review is already saved | Say it is pending and show what needs review |
| Approving review items on your own | Ask for explicit user approval first |
| Rejecting a whole task when only one file is bad | Use `--file <path>` for targeted resolution |
| Forgetting JSON output for agent workflows | Use `--format json` for structured review handling |

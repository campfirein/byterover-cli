---
name: byterover-history
description: "Use when inspecting ByteRover query logs, curate history, or recent memory activity."
---

# ByteRover History

Use history commands to audit what ByteRover queried, curated, or queued. Useful for the user asking "what was decided" or for confirming a recent curate's final shape.

## When To Inspect History

- The user asks what was recently queried, curated, or what files a recent curate touched.
- You are debugging whether memory recall happened.
- You need recall metrics or matched-doc details from prior queries.

Do not use history commands as a substitute for a fresh query when you need current project context.

## Quick Reference

```bash
# Curate history
brv curate view                                  # recent runs (newest first)
brv curate view <logId> --format json            # detail for one run
brv curate view --detail                         # full per-op detail across runs
brv curate view --limit 20                       # cap row count
brv curate view --status completed --status error # filter by status (repeatable)
brv curate view --since 1h                       # relative window (30m, 1h, 24h, 7d, 2w)
brv curate view --since 2026-05-01 --before 2026-05-15

# Query history
brv query-log view                               # recent queries + matched docs
brv query-log view <id> --format json            # detail for one query
brv query-log view --tier 0 --tier 1             # filter by recall tier (repeatable)
brv query-log view --since 24h --status completed

# Aggregate metrics
brv query-log summary                            # coverage, cache hit rate, top topics
brv query-log summary --last 7d                  # default narrative window
brv query-log summary --format narrative         # narrative output for humans
brv query-log summary --since 2026-04-01 --before 2026-04-03
```

## Curate History

Use `brv curate view` to inspect recent curate runs. Use `brv curate view <logId> --format json` when verifying a recent curate run before relying on the saved topic.

## Query History

Use `brv query-log view` to inspect recent query operations and matched docs. Use `brv query-log summary` for aggregate recall metrics such as coverage, cache behavior, and common topics.

## Common Mistakes

| Mistake | Correct behavior |
|---|---|
| Trusting a recent curate without confirming it reached `completed` | Verify with `brv curate view <logId> --format json` |
| Reading history instead of retrieving current context | Run fresh `brv query` and `brv swarm query` for new work |
| Reporting only a log id when the user asked what happened | Summarize status, files, and operations |
| Treating failed history entries as saved memory | Report the failure and re-curate if needed |

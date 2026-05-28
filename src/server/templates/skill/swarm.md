---
name: byterover-swarm
description: "Use when working with brv swarm query or brv swarm curate, especially when combining swarm recall with brv query in the required parallel retrieval workflow."
---

# ByteRover Swarm

`brv swarm` federates memory across providers such as ByteRover, Obsidian, Local Markdown, GBrain, and Memory Wiki. It is useful for broad recall, but it does not replace the project-local `brv query` path.

## When To Use Swarm

- You need to search across multiple configured memory providers.
- The user may have relevant memories outside the current context tree.
- You need provider health details before relying on swarm results.
- You want to store knowledge in an explicitly selected external provider.

Do not use swarm as the only recall path for project work; pair it with `brv query` unless the command is unavailable.

## Quick Reference

```bash
brv query "What did we decide about retry handling?" --format json
brv swarm query "What did we decide about retry handling?" --format json
brv swarm query "auth patterns" --explain
brv swarm query "testing strategy" -n 5
brv swarm status
brv swarm onboard                                                # interactive setup wizard for new providers
brv swarm curate "Jane Smith is the CTO of TechCorp" --provider gbrain
```

## Setup

Run `brv swarm onboard` when the user has not configured providers yet or asks to add a new one. It walks through provider selection, credentials, and writes the config — preferred over hand-editing config files.

## Parallel Query Protocol

For broad recall, run both commands in parallel:

```bash
brv query "How does retry handling work?" --format json
brv swarm query "How does retry handling work?" --format json
```

Use `brv query` rendered topics as primary project-local evidence. Use `brv swarm query` raw fused results as supplemental evidence, especially when memories may live outside the current context tree.

## Provider Health

Use `brv swarm status` when you need to inspect configured providers or diagnose empty swarm results.

If only ByteRover is configured, swarm results may duplicate local recall. The required broad-recall workflow still runs both commands unless the swarm command itself is unavailable.

## Swarm Curate

Use `brv swarm curate` for external or cross-project memory. Use plain `brv curate` for this project's local context tree.

Do not store project-specific code insights in external providers unless the user explicitly wants cross-project recall.

## Common Mistakes

| Mistake | Correct behavior |
|---|---|
| Treating `brv swarm query` as a replacement for `brv query` | Run both for broad project recall |
| Assuming swarm results are synthesized | Read raw results and synthesize yourself |
| Skipping `brv swarm status` when providers look empty | Check provider health and selected providers |
| Storing local project implementation facts externally by default | Use `brv curate` unless the user wants external recall |

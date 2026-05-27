---
name: byterover-query
description: "Use when you need to retrieve ByteRover memory before project work, choose between query/search/read, or combine brv query with brv swarm query."
---

# ByteRover Retrieval

Use retrieval before project-grounded work so answers and changes can build on stored project facts. `brv query` is the primary local context-tree recall command; `brv swarm query` is the required parallel companion for broader provider recall.

***HIGHLY IMPORTANT***: For hermes agent, run brv commands at  `workdir="~/.hermes/byterover/"`.

## When To Retrieve

- Before reading, changing, debugging, testing, reviewing, or planning in a project.
- Before answering a question that depends on repository context or prior decisions.
- When you need exact topic paths, rendered topic content, or cross-source memory.
- When the user asks what was decided, remembered, or done before.

Do not retrieve ByteRover memory for general knowledge unrelated to the current project.

## Quick Reference

```bash
brv query "How is authentication implemented?" --format json
brv swarm query "How is authentication implemented?" --format json
brv search "authentication patterns" --format json
brv read security/auth.html --format json
```

For broad recall, run `brv query` and `brv swarm query` in parallel:

```bash
brv query "What did we decide about retry handling?" --format json
brv swarm query "What did we decide about retry handling?" --format json
```

## Command Selection

Use `brv query "<question>" --format json` when you need ranked project topics with full rendered content. Synthesize the answer yourself from `matchedDocs[].rendered_md`, and cite topic paths when reporting.

Use `brv swarm query "<question>" --format json` alongside `brv query` for fused search across configured memory providers. Swarm returns raw results, not a synthesized answer.

Use `brv search "<terms>" --format json` when you need paths, scores, and excerpts cheaply, or when you want to scope lookup with `--scope "domain/"`.

Use `brv read <path> --format json` when you already know the exact topic path and need that one topic's full rendered content.

## Result Handling

For `brv query --format json`, branch on `data.status`:

- `ok` - synthesize from `matchedDocs[].rendered_md`.
- `no-matches` - say the knowledge base has no matching topic. The command can still be successful.

Keep queries specific. Prefer `"how is token refresh implemented"` over `"tell me about this project"`.

## Common Mistakes

| Mistake | Correct behavior |
|---|---|
| Running only `brv swarm query` for project recall | Run `brv query` too; local context-tree topics are primary |
| Treating swarm output as synthesized text | Read top results and synthesize yourself |
| Using `brv search` when full content is needed | Use `brv query` or `brv read` |
| Inventing facts when matches are thin | Say the retrieved topics do not cover the question |

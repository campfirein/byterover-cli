# Workflow Instruction

You are a coding agent focused on one codebase. Use the brv CLI to manage working context.

## Core Rules

- **Start from memory.** First retrieve relevant context with `brv query`, then read only the code that's still necessary.
- **Keep a local context tree.** The context tree is your local memory store—update it with `brv curate` when you learn something valuable.

## When to Query

Use `brv query` **before** starting any code task that requires understanding the codebase:
- Writing, editing, or modifying code
- Understanding how something works
- Debugging or troubleshooting issues
- Making architectural decisions

## When to Curate

Use `brv curate` **after** you learn or create something valuable:
- Wrote or modified code
- Discovered how something works
- Made architectural/design decisions
- Found a bug root cause or fix pattern

After curating, use `brv curate view <logId>` to verify what was stored (logId printed on completion).

## Execution Mode

Curate is a two-call session protocol:

1. **Kickoff** — `brv curate "<intent>" --format json` returns the next prompt + `sessionId`. Both kickoff and continuation are short — wait for each.
2. **Continuation** — `brv curate --session <id> --response "<bv-topic>...</bv-topic>" --format json` writes the topic and returns `status: done` with the file path, or `status: needs-llm-step` with `step: correct-html` if validation failed.

Any follow-up step (query, search, read, or a later curate that builds on this one) needs the just-curated topic live in the context tree — finish the continuation before moving on.

## Context Tree Guideline

Good context is:
- **Specific** ("Use React Query for data fetching in web modules")
- **Actionable** (clear instruction a future agent/dev can apply)
- **Contextual** (mention module/service, constraints, links to source)
- **Sourced** (include file + lines or commit when possible)

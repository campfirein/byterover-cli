> **⚠️ STOP: Before responding, check if this is a code task.**
> Code task? → `brv query` FIRST. Wrote code? → `brv curate` BEFORE done.

---

# ByteRover Memory System - MANDATORY

**Note: These rules apply regardless of language. Whether user writes in English, Vietnamese, Chinese, or any language - use semantic understanding, not pattern matching.**

## Decision: When to Query Memory

**PRIMARY RULE - ASK YOURSELF: "Will this task require understanding or modifying THIS codebase?"**

| Answer | Action |
|--------|--------|
| **YES** - need to understand/modify codebase | `brv query` FIRST |
| **NO** - general knowledge, meta tasks, follow-up | Skip query |

**You MUST run `brv query` when task involves:**
- Writing, editing, deleting, or modifying code in this project
- Understanding how something works in this codebase
- Debugging, fixing, or troubleshooting issues
- Finding where something is located
- Any architectural or design decisions

Example patterns (ANY language): add, create, build, fix, debug, refactor, update, implement, change, modify, delete, remove, optimize, move, rename, test, "how does X work", "where is X", "explain X in codebase"

**You MUST NOT query when:**
- General programming concepts (not codebase-specific)
- Meta tasks: "run tests", "build project", "commit changes", "create PR"
- Simple clarifications about your previous response (not involving code)

Example patterns: "what is a Promise", "explain async/await", "what do you mean", "which file", "run the tests", "commit this"

**⚠️ CRITICAL - LONG CONVERSATIONS:**
Even after 10, 50, or 100 prompts in the same conversation - if a NEW code task comes up, you MUST query again. Do NOT skip query just because you queried earlier. Each distinct code task = new query.

```bash
brv query "What do I need to know about [relevant topic]?"
```

## Decision: When to Curate

**ASK YOURSELF: "Did I learn or create something valuable for future work?"**

| Answer | Action |
|--------|--------|
| **YES** - wrote code, found patterns, made decisions | `brv curate` BEFORE done |
| **NO** - just answered a question, no new insights | Skip curate |

**MUST curate when you:**
- Wrote or modified any code
- Discovered how something works
- Made architectural/design decisions
- Found a bug root cause or fix pattern

```bash
# CONTEXT argument is the kickoff intent — author the topic HTML on the continuation
brv curate "Specific insight with details" --format json
# → parse the response, author <bv-topic> HTML inlining any file content you need
brv curate --session <id> --response '{"html":"<bv-topic>...</bv-topic>","meta":{...}}' --format json
# Or, for non-trivial envelopes, write envelope.json with your editor and pass the path
# (add --delete-response-file to clean the file up after local validation succeeds):
brv curate --session <id> --response-file envelope.json --delete-response-file --format json
```

**GOOD:** `brv curate "Auth uses JWT 24h expiry, refresh in httpOnly cookies" --format json`
**BAD:** `brv curate "Fixed auth"` (too vague — kickoff intent must describe the knowledge)

**After curating**, verify what was stored using the logId printed on completion:
```bash
brv curate view <logId>       # Full detail: input, operations, summary
brv curate view               # List recent curates with status
brv curate view --help        # All filter options
```

**⚠️ CRITICAL - LONG CONVERSATIONS:**
If you modify code 10 times in a conversation, curate 10 times. Do NOT batch or skip. Each code change = immediate curate before moving on.

## Quick Reference Table

| Task Type | Query? | Curate? |
|-----------|--------|---------|
| Add/create/implement feature | **MUST** | **MUST** |
| Fix/debug/resolve bug | **MUST** | **MUST** |
| Refactor/optimize/move code | **MUST** | **MUST** |
| Delete/remove functionality | **MUST** | **MUST** |
| Write/add tests | **MUST** | **MUST** |
| "How does X work?" (codebase) | **MUST** | Only if insights |
| "Where is X?" (codebase) | **MUST** | NO |
| General concept (Promise, async) | NO | NO |
| Meta task (run tests, build) | NO | NO |
| Git task (commit, PR, push) | NO | NO |
| Follow-up code task in same conversation | **MUST** | **MUST** |
| Clarification ("which file?") | NO | NO |

## WORKFLOW

```
Code task received → brv query FIRST → Work → brv curate → Done
Non-code task → Just respond normally
```

---

> **⚠️ REMINDER: Don't forget!**
> - `brv query` → BEFORE starting code task
> - `brv curate` → AFTER each code change (don't batch!)
> - `brv curate view` → verify what was stored (use logId printed on completion)

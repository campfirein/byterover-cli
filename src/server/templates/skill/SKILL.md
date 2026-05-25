---
name: byterover
description: "You MUST use this for gathering contexts before any work. This is a Knowledge management for AI agents. Use `brv` to store and retrieve project patterns, decisions, and architectural rules in .brv/context-tree. Uses a configured LLM provider (default: ByteRover, no API key needed) for query and curate operations."
---

# ByteRover Knowledge Management

Use the `brv` CLI to manage your project's long-term memory.
Install: `npm install -g byterover-cli`
Knowledge is stored in `.brv/context-tree/` as human-readable Markdown files.

**No authentication needed.** `brv query`, `brv swarm query`, `brv curate`, and `brv vc` (local version control) work out of the box. Login is only required for remote sync (`brv vc push`/`brv vc pull`).

## Workflow
1.  **Before Thinking:** Run `brv query` and `brv swarm query` in parallel to understand existing patterns.
2.  **After Implementing:** Run `brv curate` to save new patterns/decisions.

## Commands

### 1. Query Knowledge
**Overview:** Retrieve relevant context from your project's knowledge base. Uses a configured LLM provider to synthesize answers from `.brv/context-tree/` content.

**Use this skill when:**
- The user wants you to recall something
- Your context does not contain information you need
- You need to recall your capabilities or past actions
- Before performing any action, to check for relevant rules, criteria, or preferences

**Do NOT use this skill when:**
- The information is already present in your current context
- The query is about general knowledge, not stored memory

```bash
brv query "How is authentication implemented?"
```

### 2. Search Context Tree
**Overview:** Retrieve a ranked list of matching files from `.brv/context-tree/` via pure BM25 lookup. Unlike `brv query`, this does NOT call an LLM — no synthesis, no token cost, no provider setup needed. Returns structured results with paths, scores, and excerpts.

**Use this skill when:**
- You need file paths to read rather than a synthesized answer
- You want fast, cheap retrieval with no LLM overhead
- You're in an automated pipeline that consumes structured results

**Do NOT use this skill when:**
- You need a natural-language answer synthesized from multiple files — use `brv query` instead
- The information is already present in your current context

```bash
brv search "authentication patterns"
brv search "JWT tokens" --limit 5 --scope "auth/"
brv search "auth" --format json
```

**Flags:** `--limit N` (1-50, default 10), `--scope "domain/"` (path prefix filter), `--format json` (structured output for automation).

### 3. Curate Context
**Overview:** Analyze and save knowledge to the local knowledge base. Uses a configured LLM provider to categorize and structure the context you provide.

**Use this skill when:**
- The user wants you to remember something
- The user intentionally curates memory or knowledge
- There are meaningful memories from user interactions that should be persisted
- There are important facts about what you do, what you know, or what decisions and actions you have taken

**Do NOT use this skill when:**
- The information is already stored and unchanged
- The information is transient or only relevant to the current task, or just general knowledge

```bash
brv curate "Auth uses JWT with 24h expiry. Tokens stored in httpOnly cookies via authMiddleware.ts"
```

**Include source files** (max 5, project-scoped only):

```bash
brv curate "Authentication middleware details" -f src/middleware/auth.ts
```

**Execution mode: wait by default**

Default is **blocking** — call `brv curate "..."` with no flag and wait for it to finish before continuing. Any follow-up step (query, search, read, review, next curate that builds on this one) may depend on the just-curated data being live in the context tree.

```bash
brv curate "..."                 # DEFAULT — wait until done, then continue
brv curate "..." --detach        # Only when BOTH conditions below hold
```

**Use `--detach` only when BOTH of the following are true:**

1. No remaining step in this turn will query, search, read, or reference this curated data, AND no later curate in this turn builds on it.
2. The user explicitly said not to wait — phrases addressed *to you* like "don't wait", "don't block on this", "fire and forget", "move on without waiting". The phrase must be something the user says to the agent, not something the agent would narrate about itself. This rules out "run in background" and "run async" as triggers — agents use those phrases to self-narrate at least as often as users use them to instruct, which creates a mirror-priming loop.

**If the user's phrasing is ambiguous, wait.** Detach requires an unambiguous signal. "Quick one, keep moving" is not enough.

If either condition is uncertain, do not `--detach`. Wait.

**Size/duration is NOT a reason to `--detach`.** A slow curate whose output the next step reads must still block. **"Looks like the last step" is also NOT a reason** — that is a guess, not evidence.

**Reporting:**
- Blocking (default) → "Saved X"
- `--detach` → "Queued X (log: `<logId>`)" — do NOT claim "saved" until verified

**Cross-turn hygiene for detached curates (CRITICAL):** before any later tool call reads data a previous `--detach` submitted, run:

```bash
brv curate view <logId> --format json
```

Only proceed when `status: completed`. If `processing`, wait or tell the user. If `error`/`cancelled`, report and consider re-curate. `--detach` errors are silent — verification before trust is mandatory.

### 4. Review Pending Changes
**Overview:** After a curate operation, some changes may require human review before being applied. Use `brv review` to list, approve, or reject pending operations.

**Use this when:**
- A curate operation reports pending reviews (shown in curate output)
- The user wants to check, approve, or reject pending changes

**Do NOT use this skill when:**
- There are no pending reviews (check with `brv review pending` first)

**Commands:**

List all pending reviews for the current project:
```bash
brv review pending
```

Sample output:
```
2 operations pending review

  Task: ddcb3dc6-d957-4a56-b9c3-d0bdc04317f3
  [UPSERT · HIGH IMPACT] - path: architecture/context/context_compression_pipeline.md
  Why:    Documenting switch to token-budget sliding window
  After:  Context compression pipeline switching from reactive-overflow to token-budget sliding window in src/agent/infra/llm/context/compression/

  [UPSERT · HIGH IMPACT] - path: architecture/tools/agent_tool_registry.md
  Why:    Documenting tool registry rewrite with capability-based permissions
  After:  Agent tool registry rewrite in src/agent/infra/tools/tool-registry.ts using capability-based permissions

  To approve all:  brv review approve ddcb3dc6-d957-4a56-b9c3-d0bdc04317f3
  To reject all:   brv review reject ddcb3dc6-d957-4a56-b9c3-d0bdc04317f3
  Per file:        brv review <approve|reject> ddcb3dc6-d957-4a56-b9c3-d0bdc04317f3 --file <path> [--file <path>]
```

Each pending task shows: operation type (ADD/UPDATE/DELETE/MERGE/UPSERT), file path, reason, and before/after summaries. High-impact operations are flagged.

Approve all operations for a task (applies the changes):
```bash
brv review approve <taskId>
```

Reject all operations for a task (discards pending changes; restores backup for UPDATE/DELETE operations):
```bash
brv review reject <taskId>
```

Approve or reject specific files within a task:
```bash
brv review approve <taskId> --file <path> --file <path>
brv review reject <taskId> --file <path>
```
File paths are relative to context tree (as shown in `brv review pending` output).

**Note**: Always ask the user before approving or rejecting critical changes.

**JSON output** (useful for agent-driven workflows):
```bash
brv review pending --format json
brv review approve <taskId> --format json
brv review reject <taskId> --format json
```

### 5. LLM Provider Setup
`brv query` and `brv curate` require a configured LLM provider. Connect the default ByteRover provider (no API key needed):

```bash
brv providers connect byterover
```

To use a different provider (e.g., OpenAI, Anthropic, Google), list available options and connect with your own API key:

```bash
brv providers list
brv providers connect openai --api-key sk-xxx --model gpt-4.1
```

### 6. Project Locations
**Overview:** List registered projects and their context tree paths. Returns project metadata including initialization status and active state. Use `-f json` for machine-readable output.

**Use this when:**
- You need to find a project's context tree path
- You need to check which projects are registered
- You need to verify if a project is initialized

**Do NOT use this when:**
- You already know the project path from your current context
- You need project content rather than metadata — use `brv query` instead

```bash
brv locations -f json
```

JSON fields: `projectPath`, `contextTreePath`, `isCurrent`, `isActive`, `isInitialized`.

### 7. Version Control
**Overview:** `brv vc` provides git-based version control for your context tree. It uses standard git semantics — branching, committing, merging, history, and conflict resolution — all working locally with no authentication required. Remote sync with a team is optional. The legacy `brv push`, `brv pull`, and `brv space` commands are deprecated — use `brv vc push`, `brv vc pull`, and `brv vc clone`/`brv vc remote add` instead.

**Use this when:**
- The user wants to track, commit, or inspect changes to the knowledge base
- The user wants to branch, merge, or undo knowledge changes
- The user wants to sync knowledge with a team (push/pull)
- The user wants to connect to or clone a team space
- The user asks about knowledge history or diffs

**Do NOT use this when:**
- The user wants to query or curate knowledge — use `brv query`/`brv curate` instead
- The user wants to review pending curate operations — use `brv review` instead
- Version control is not initialized and the user didn't ask to set it up

**Commands:**

Available commands: `init`, `status`, `add`, `commit`, `reset`, `log`, `branch`, `checkout`, `merge`, `config`, `clone`, `remote`, `fetch`, `push`, `pull`.

#### First-Time Setup

**Setup — local (no auth needed):**
```bash
brv vc init
brv vc config user.name "Your Name"
brv vc config user.email "you@example.com"
```

**Setup — clone a team space (requires `brv login`):**
```bash
brv login --api-key sample-key-string
brv vc clone https://byterover.dev/<team>/<space>.git
```

**Setup — connect existing project to a remote (requires `brv login`):**
```bash
brv login --api-key sample-key-string
brv vc remote add origin https://byterover.dev/<team>/<space>.git
```

#### Local Workflow

**Check status:**
```bash
brv vc status
```

**Stage and commit:**
```bash
brv vc add .                     # stage all
brv vc add notes.md docs/        # stage specific files
brv vc commit -m "add authentication patterns"
```

**View history:**
```bash
brv vc log
brv vc log --limit 20
brv vc log --all
```

**Unstage or undo:**
```bash
brv vc reset                     # unstage all files
brv vc reset <file>              # unstage a specific file
brv vc reset --soft HEAD~1       # undo last commit, keep changes staged
brv vc reset --hard HEAD~1       # discard last commit and changes
```

#### Branch Management

```bash
brv vc branch                    # list branches
brv vc branch feature/auth       # create a branch
brv vc branch -a                 # list all (including remote-tracking)
brv vc branch -d feature/auth    # delete a branch
brv vc checkout feature/auth     # switch branch
brv vc checkout -b feature/new   # create and switch
```

**Merge:**
```bash
brv vc merge feature/auth        # merge into current branch
brv vc merge --continue          # continue after resolving conflicts
brv vc merge --abort             # abort a conflicted merge
```

**Set upstream tracking:**
```bash
brv vc branch --set-upstream-to origin/main
```

#### Cloud Sync (Remote Operations)

Requires ByteRover authentication (`brv login`) and a configured remote.

**Manage remotes:**
```bash
brv vc remote                    # show current remote
brv vc remote add origin <url>   # add a remote
brv vc remote set-url origin <url>  # update remote URL
```

**Fetch, pull, and push:**
```bash
brv vc fetch                     # fetch remote refs
brv vc pull                      # fetch + merge remote commits
brv vc push                      # push commits to cloud
brv vc push -u origin main       # push and set upstream tracking
```

**Clone a space:**
```bash
brv vc clone https://byterover.dev/<team>/<space>.git
```

### 8. Swarm Query
**Overview:** Search across all active memory providers simultaneously — ByteRover context tree, Obsidian vault, Local Markdown folders, GBrain, and Memory Wiki. Results are fused via Reciprocal Rank Fusion (RRF) and ranked by provider weight and relevance. No LLM call — pure algorithmic search. When multiple memory providers are configured, run `brv swarm query` alongside `brv query` to broaden recall at near-zero token cost.

**Use this skill when:**
- You need to search across multiple knowledge sources at once
- The user has configured multiple memory providers (check with `brv swarm status`)
- You want results from Obsidian notes, GBrain entities, or wiki pages alongside ByteRover context

**Do NOT use this skill when:**
- The user only has ByteRover configured — use `brv query` instead (it synthesizes via LLM)
- You need an LLM-synthesized answer — `brv swarm query` returns raw search results, not synthesized text

```bash
brv swarm query "How does JWT refresh work?"
```

Output:
```
Swarm Query: "How does JWT refresh work?"
Type: factual | Providers: 4 queried | Latency: 398ms
──────────────────────────────────────────────────
1. [memory-wiki] sources/jwt-token-lifecycle.md    score: 0.0150  [keyword]
   # JWT Token Lifecycle ...
2. [obsidian] SwarmTestData/Authentication System.md    score: 0.0142  [keyword]
   # Authentication System ...
3. [gbrain] alex-chen    score: 0.0117  [semantic]
   # Alex Chen — Senior Backend Engineer ...
```

**With explain mode** (shows classification, provider selection, enrichment):
```bash
brv swarm query "authentication patterns" --explain
```

Output:
```
Classification: factual
Provider selection: 4 of 4 available
  ✓ byterover    (healthy, selected, 0 results, 14ms)
  ✓ obsidian    (healthy, selected, 5 results, 91ms)
  ✓ memory-wiki    (healthy, selected, 2 results, 15ms)
  ✓ gbrain    (healthy, selected, 1 results, 260ms)
Enrichment:
  byterover → obsidian
  byterover → memory-wiki
Results: 8 raw → 7 after RRF fusion + precision filtering
```

**JSON output:**
```bash
brv swarm query "rate limiting" --format json
```

Output:
```json
{
  "meta": {
    "queryType": "factual",
    "totalLatencyMs": 340,
    "providers": {
      "byterover": { "selected": true, "resultCount": 0 },
      "obsidian": { "selected": true, "resultCount": 5 },
      "gbrain": { "selected": true, "resultCount": 1 },
      "memory-wiki": { "selected": true, "resultCount": 1 }
    }
  },
  "results": [
    { "provider": "memory-wiki", "providerType": "memory-wiki", "score": 0.015, "content": "# Rate Limiting ..." }
  ]
}
```

**Limit results:**
```bash
brv swarm query "testing strategy" -n 5
```

**Flags:** `--explain` (show routing details), `--format json` (structured output), `-n <value>` (max results).

### 9. Swarm Curate
**Overview:** Store knowledge in the best available external memory provider. ByteRover automatically classifies the content type and routes accordingly: entities (people, orgs) go to GBrain, notes (meeting notes, TODOs) go to Local Markdown, general content goes to the first writable provider. Falls back to ByteRover context tree if no external providers are available.

**Use this skill when:**
- You want to store knowledge in an external provider (GBrain, Local Markdown, Memory Wiki)
- The user has configured writable swarm providers

**Do NOT use this skill when:**
- You want to store in ByteRover's context tree specifically — use `brv curate` instead
- No swarm providers are configured — use `brv curate` instead

```bash
brv swarm curate "Jane Smith is the CTO of TechCorp"
```

Output:
```
Stored to gbrain as concept/jane-smith-cto
```

**Target a specific provider:**
```bash
brv swarm curate "meeting notes: decided on JWT" --provider local-markdown:notes
```

Output:
```
Stored to local-markdown:notes as note-1776052527043.md
```

```bash
brv swarm curate "Architecture uses event sourcing" --provider gbrain
```

Output:
```
Stored to gbrain as concept/event-sourcing-architecture
```

**JSON output:**
```bash
brv swarm curate "Test content" --format json
```

Output:
```json
{
  "id": "note-1776052594462.md",
  "provider": "local-markdown:project-docs",
  "success": true,
  "latencyMs": 1
}
```

**Flags:** `--provider <id>` (target specific provider), `--format json` (structured output).

### 10. Swarm Status
**Overview:** Check provider health and write targets before running swarm query or curate. Use this to verify which providers are available and operational.

**Use this skill when:**
- Before running `brv swarm query` or `brv swarm curate` to check available providers
- Diagnosing why swarm results are missing from a specific provider

```bash
brv swarm status
```

Output:
```
Memory Swarm Health Check
════════════════════════════════════════
  ✓ ByteRover       context-tree (always on)
  ✓ Obsidian        /Users/you/Documents/MyObsidian
  ✓ Local .md       1 folder(s)
  ✓ GBrain          /Users/you/workspaces/gbrain
  ✓ Memory Wiki     /Users/you/.openclaw/wiki/main

Write Targets:
  gbrain (entity, general)
  local-markdown:project-docs (note, general)

Swarm is operational (5/5 providers configured).
```

### 11. Query and Curate History
**Overview:** Inspect past query and curate operations. Use `brv query-log view` to review query history, `brv curate view` to review curate history, and `brv query-log summary` to see aggregated recall metrics. Supports filtering by time, status, tier, and detailed per-operation output.

**Use this skill when:**
- You want to review what was queried or curated previously
- You need to inspect a specific operation by logId
- You want to filter history by time window or completion status
- You want to collect data for analysis or debugging
- You want to know what knowledge was added, updated, or deleted over time
- You want aggregated metrics on query recall, cache hit rate, or knowledge gaps

**Do NOT use this skill when:**
- You want to run a new query — use `brv query` instead
- You want to curate new knowledge — use `brv curate` instead

**View curate history:** to check past curations
- Show recent entries (last 10)
```bash
brv curate view
```
- Full detail for a specific entry: all files and operations performed (logId is printed by `brv curate` on completion, e.g. `cur-1739700001000`)
```bash
brv curate view cur-1739700001000
```
- List entries with file operations visible (no logId needed)
```bash
brv curate view --detail
```
- Filter by time and status
```bash
brv curate view --since 1h --status completed --limit 1000
```
- For all filter options
```bash
brv curate view --help
```

**View query history:** to check past queries
- Show recent entries (last 10)
```bash
brv query-log view
```
- Full detail for a specific entry: matched docs and search metadata (logId is printed by `brv query` on completion, e.g. `qry-1739700001000`)
```bash
brv query-log view qry-1739700001000
```
- List entries with matched docs visible (no logId needed)
```bash
brv query-log view --detail
```
- Filter by time, status, or resolution tier (0=exact cache, 1=fuzzy cache, 2=direct search, 3=optimized LLM, 4=full agentic)
```bash
brv query-log view --since 1h --status completed --limit 1000
brv query-log view --tier 0 --tier 1
```
- For all filter options
```bash
brv query-log view --help
```

**View query recall metrics:** to see aggregated stats across recent queries
- Summary for the last 24 hours (default)
```bash
brv query-log summary
```
- Summary for a specific time window
```bash
brv query-log summary --last 7d
brv query-log summary --since 2026-04-01 --before 2026-04-03
```
- Narrative format (human-readable prose report)
```bash
brv query-log summary --format narrative
```
- For all options
```bash
brv query-log summary --help
```

## Data Handling

**Storage**: All knowledge is stored as Markdown files in `.brv/context-tree/` within the project directory. Files are human-readable and version-controllable.

**File access**: The `-f` flag on `brv curate` reads files from the current project directory only. Paths outside the project root are rejected. Maximum 5 files per command, text and document formats only.

**LLM usage**: `brv query` and `brv curate` send context to a configured LLM provider for processing. The LLM sees the query or curate text and any included file contents. No data is sent to ByteRover servers unless you explicitly run `brv vc push`.

**Cloud sync**: `brv vc push` and `brv vc pull` require authentication (`brv login`) and sync knowledge with ByteRover's cloud service via git. All other commands operate without ByteRover authentication.

## Error Handling
**User Action Required:**
You MUST show this troubleshooting guide to users when errors occur.

"Not authenticated" | Run `brv login --help` for more details.
"No provider connected" | Run `brv providers connect byterover` (free, no key needed).
"Connection failed" / "Instance crashed" | User should kill brv process.
"Token has expired" / "Token is invalid" | Run `brv login` again to re-authenticate.
"Billing error" / "Rate limit exceeded" | User should check account credits or wait before retrying.

**Agent-Fixable Errors:**
You MUST handle these errors gracefully and retry the command after fixing.

"Missing required argument(s)." | Run `brv <command> --help` to see usage instructions.
"Maximum 5 files allowed" | Reduce to 5 or fewer `-f` flags per curate.
"File does not exist" | Verify path with `ls`, use relative paths from project root.
"File type not supported" | Only text, image, PDF, and office files are supported.

### Quick Diagnosis
Run `brv status` to check authentication, project, and provider state.

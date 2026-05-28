---
name: byterover-dream
description: "Use when consolidating, deduping, pruning, or organizing the ByteRover context tree via brv dream's three-phase scan → curate → finalize workflow."
---

# ByteRover Dream

`brv dream` is a three-phase deterministic pass over `.brv/context-tree/` that surfaces cleanup candidates (link, merge, prune, synthesize) for YOU to act on. No LLM is invoked on the daemon side — the daemon enumerates structural candidates, you do the semantic judgement via `brv curate` writes, then `brv dream finalize` archives the loser topics. The pipeline runs without any provider configured.

## When To Use Dream

- The user asks to consolidate, dedupe, prune, or organize the context tree.
- You notice the tree has accumulated near-duplicate or stale topics over time.
- You want to surface cross-link opportunities between adjacent topics.

## When NOT To Use Dream

- The tree is fresh or small (< ~10 topics) — there is nothing meaningful to clean up yet.
- The user only wants to search or query — use `brv query` / `brv search` instead.
- An open `brv curate` session is in flight — finish it first; do not interleave dream with curate sessions.

## Quick Reference

```bash
brv dream scan --format json
brv dream scan --kinds link,merge --scope security/ --max-candidates 20 --format json
brv dream finalize --session <sessionId> --archive testing/old-notes.html,redis/cache.html --format json
brv dream undo --format json
```

## Three-Phase Workflow

### Phase 1 — Scan

```bash
brv dream scan --format json
```

Returns a `sessionId` (uuid) and `candidates` keyed by kind. Hold the `sessionId` until Phase 3.

- `link` — BM25-similar topic pairs not yet cross-linked. To act: extend each topic's `related=` attribute on `<bv-topic>` (comma-separated refs) with the partner's path, then re-call `brv curate` at each existing path. The documented convention is the bare `@domain/topic` form (see `curate.md` examples like `related="@security/cookies,@security/oauth"`); the topic loader normalizes by appending `.html` internally, so both `@security/oauth` and `@security/oauth.html` resolve to the same edge. Prefer bare to match the convention; if you copy a path verbatim from `dream scan` (which emits the `.html`-suffixed form), that also works. When you submit the authored HTML during the curate continuation step, the writer detects that the topic already exists and returns `kind: "path-exists"` with the topic's `existingContent`; merge your additions in and re-emit with `--overwrite` to apply the write.
- `merge` — BM25 near-duplicates. Pick a survivor, author HTML combining both topic bodies, write it via the same `brv curate` `path-exists` / `--overwrite` flow at the survivor's existing path, then archive the loser via `brv dream finalize`. The writer normalizes the `<bv-topic path="...">` attribute idempotently — both `path="auth/jwt"` (bare convention) and `path="auth/jwt.html"` (the form `dream scan` emits) resolve to the same on-disk file at `auth/jwt.html` and trigger the path-exists guard identically. Either form is safe.
- `prune` — Low-importance (sidecar `importance < 35`) or stale-mtime (draft >60d / validated >120d) topics. Topics with `maturity: 'core'` are never surfaced. Each candidate carries `reason: 'low-importance' | 'stale-mtime' | 'both'`, `daysSinceModified`, and the full `signals` block. Decide per candidate: archive it via `brv dream finalize`, leave it alone, or treat it as a `merge` candidate against another topic.
- `synthesize` — Per-domain topic groups plus existing synthesis topics. To act: author a new `<bv-topic>` at a fresh path under `synthesis/<slug>` and call `brv curate` to write it — no `path-exists` branch applies because the path is new.

Sample scan envelope (top-level JSON object emitted by `--format json`):

```json
{
  "sessionId": "8c3f9e2a-...",
  "status": "ok",
  "candidates": {
    "link": [
      {"pair": ["security/jwt.html", "security/sessions.html"], "score": 0.71,
       "htmlA": "<bv-topic path=\"security/jwt\" ...>...</bv-topic>",
       "htmlB": "<bv-topic path=\"security/sessions\" ...>...</bv-topic>"}
    ],
    "merge": [
      {"pair": ["auth/oauth.html", "auth/oauth-flow.html"], "score": 0.93,
       "htmlA": "<bv-topic path=\"auth/oauth\" ...>...</bv-topic>",
       "htmlB": "<bv-topic path=\"auth/oauth-flow\" ...>...</bv-topic>"}
    ],
    "prune": [
      {"path": "legacy/old-notes.html", "reason": "both",
       "daysSinceModified": 70,
       "signals": {"importance": 15, "maturity": "draft", "accessCount": 0, "recency": 0.1, "updateCount": 0},
       "html": "<bv-topic path=\"legacy/old-notes\" ...>...</bv-topic>"}
    ],
    "synthesize": {
      "domains": [
        {"domain": "caching", "topics": [{"path": "caching/redis.html", "title": "Redis", "summary": "..."}]}
      ],
      "existingSyntheses": [
        {"path": "synthesis/caching-overview.html", "title": "Caching overview", "summary": "..."}
      ]
    }
  }
}
```

Filter scope or kinds when the tree is large:

```bash
brv dream scan --kinds link,merge --scope security/ --max-candidates 20 --format json
```

### Phase 2 — Act

Invoke `brv curate` (per `curate.md`) for each candidate you decide to act on. Keep the `sessionId` from Phase 1 — you need it for finalize.

For `link` and `merge` actions, the writer returns `kind: "path-exists"` when you submit the authored HTML during the curate continuation step (the kickoff step just hands you a `generate-html` prompt with no validation). Read `existingContent` from that error, merge with your additions, and continue the same curate session with `--overwrite`. Never shrink the topic — enrichment only; every prior fact stays.

### Phase 3 — Finalize

```bash
brv dream finalize --session <sessionId> --archive testing/old-notes.html,redis/cache.html --format json
```

Archive paths MUST match exactly what `dream scan` emitted: full relative path under `.brv/context-tree/`, with `.html` extension. Files move to `.brv/archive/<path>` and a dream-log entry is written so the operation is undoable.

- `--archive` and `--archive-file <path>` are mutually exclusive; exactly one is required.
- The archive list is capped at 200 entries per call; split into multiple finalize calls for larger batches.

Sample finalize response (top-level JSON object emitted by `--format json`):

```json
{
  "archived": ["legacy/old-notes.html", "auth/oauth-flow.html"],
  "skipped": [],
  "logId": "drm-1779360938860",
  "status": "ok"
}
```

`skipped` entries carry `{"path": "...", "reason": "already-archived|not-found|rename-failed|unsafe-path"}`. `logId` identifies the dream-log entry (only emitted when at least one path was archived); `brv dream undo` takes no arguments and always reverts the most recent finalize from the on-disk dream state.

### Undo The Most Recent Finalize

```bash
brv dream undo --format json
```

Restores archived topics to their original locations bit-exact: content, original mtime, and sidecar runtime signals (importance / maturity / accessCount / etc.) are all restored. Pruned topics that re-qualify will re-surface on the next scan. Curate writes from Phase 2 are NOT rolled back by undo — use `brv review reject <taskId>` for those (see `review.md`).

### Worked Example — Prune The Stalest Topic (No Curate Detour)

```bash
# 1. Scan only prune candidates
brv dream scan --kinds prune --format json
# → response carries candidates.prune[]; pick the highest daysSinceModified entry,
#   say "legacy/old-notes.html"

# 2. Archive it. sessionId from step 1 is opaque; pass any string in v1.
brv dream finalize --session <id> --archive legacy/old-notes.html --format json
# → archived: ["legacy/old-notes.html"], skipped: [], logId: "drm-..."

# 3. If you change your mind, revert.
brv dream undo --format json
```

## Stateless v1 Notes

- `brv dream sessions` returns an empty list — the daemon does not persist session state. The JSON envelope carries a `note` field disclosing this.
- `brv dream cancel --session <id>` is a no-op for the same reason; its JSON envelope also carries a `note`.
- The `sessionId` from scan is for your bookkeeping between scan and finalize; the daemon does not enforce or persist it.

## Red Flags — STOP

- About to call `brv dream finalize` before completing the Phase 2 curate writes → **STOP, finalize only archives losers; it does NOT preserve their content in the survivor.**
- About to pass an archive path that differs from what `dream scan` emitted (missing `.html`, different relative root) → **STOP, copy paths verbatim from the scan output.**
- About to run `brv dream undo` to roll back Phase 2 curate writes → **STOP, undo only reverses the most recent finalize; reject curate writes via `brv review reject`.**
- About to run dream on a tree with < ~10 topics → **STOP, there is nothing meaningful to consolidate yet.**
- About to shrink a merge survivor to "tidy" it → **STOP, enrichment only — every prior fact from both topics must survive.**

## Common Mistakes

| Mistake | Correct behavior |
|---|---|
| Finalizing before Phase 2 curate writes complete | Run all Phase 2 curates first; finalize only archives, it does not preserve content |
| Shrinking the merge survivor to "tidy" the topic | Enrichment only — preserve every prior fact from both source topics |
| Re-running scan mid-session to refresh the candidate list | Hold one `sessionId` start-to-finish; restart only if you abandon the session |
| Skipping `--scope` on a large tree and drowning in candidates | Filter by `--scope <domain>/` or `--kinds <list>` for a manageable batch |
| Treating dream as a retrieval command | Dream consolidates, it does not retrieve; use `brv query` / `brv search` for recall |
| Using `brv dream undo` to revert curate writes from Phase 2 | Undo only reverses the most recent finalize archive operation; use `brv review reject <taskId>` for curate writes |

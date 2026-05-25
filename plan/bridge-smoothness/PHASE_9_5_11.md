# Phase 9.5.11 — Exclude `channel/` from VC tracking (vanish-prevention)

**Status:** shipped (single-file gitignore-pattern change)
**Predecessor:** Phase 9.5.10 (`9fbc7ac6c`) — added reconstruction recovery layer.
**Trigger:** 2026-05-25 audit of all `fs.rm`/`fs.unlink` call sites + channel-path-touching code (laptop session).

---

## Why

The recurring "`context-tree/channel/<id>/meta.json` vanishes" symptom motivated 9.5.9 (BrvDirWatcher observability) and 9.5.10 (reconstruction recovery), but neither addressed the underlying cause. The 2026-05-25 audit traced it to **VC tree-replace operations** (checkout, reset, clone, merge) hitting tracked channel meta files:

- `.brv/context-tree/channel/<id>/` was intentionally cogit-synced per a pre-bridge design comment in `src/server/infra/channel/storage/paths.ts:7-10`.
- `channel/` was **not** in `CONTEXT_TREE_GITIGNORE_PATTERNS`, so the brv vc layer tracked channel files.
- Any subsequent `brv vc checkout <branch>` to a branch whose tree didn't contain a given channel removed it from the working directory — the vanish event.
- `channel-history/<id>/` (turn transcripts) is **structurally outside** `context-tree/` and therefore never affected — matching the observed pattern that `channel-history` always survived.
- Since the libp2p bridge took over cross-host channel state, VC sync of channels is no longer load-bearing.

The audit also looked at:

- `transcript-gc.ts` — scoped to per-turn dirs, never touches `channel/<id>/`.
- `channel-store.ts` — only writes, never deletes.
- `vc-handler.ts` — removes only `.git` + `.gitignore` directly; the harm comes via the subsequent git tree-replace it triggers.
- `worktree`, `project-registry`, `webui-state`, `transcript-gc` — all scoped to their own data.

VC tree-replace was the only path consistent with the observed vanish/`channel-history`-survives pattern.

---

## What

Add `/channel/` to `CONTEXT_TREE_GITIGNORE_PATTERNS` in `src/server/constants.ts`. Anchored form (leading `/`) so it only matches the context-tree-root-level `channel/` dir.

Result:

- Future channel writes are never staged by `brv vc add`.
- Future VC tree-replace ops cannot touch `channel/` because git treats it as untracked.
- The 9.5.10 reconstruction layer remains as the safety net for any pre-existing vanish.

Touched files:

| File | Change |
|---|---|
| `src/server/constants.ts` | Append `/channel/` to `CONTEXT_TREE_GITIGNORE_PATTERNS` with a comment explaining why |
| `src/server/infra/channel/storage/paths.ts` | Update the path-comment block — channels are now local-only |
| `test/unit/server/constants.test.ts` | Add an it-block asserting `/channel/` is in the patterns |
| `test/unit/server/utils/gitignore-channel-exclude.test.ts` (new) | TDD coverage — fresh write, idempotence, in-place upgrade |

---

## Migration for existing users

This fix is **preventive only**. Channel files already in a user's local git index remain tracked until the user explicitly untracks them:

```bash
cd .brv/context-tree
git rm --cached -r channel/
git commit -m "untrack channel state per Phase 9.5.11"
```

No automatic migration is performed because:

- The daemon cannot know whether a given user genuinely wants channels synced via VC (some pre-bridge workflows did).
- Auto-untrack on a future startup would surprise users who haven't read this changelog entry.

If a future user reports a vanish event despite running 9.5.11+, the doctor surface and `brv channel reconstruct` (or equivalent) can guide them through the manual untrack.

---

## Out of scope

- Auto-untrack migration (operator-driven, not in this slice).
- Refactoring `vc-handler.ts` checkout logic (the gitignore change is sufficient).
- Removing the 9.5.10 reconstruction layer (still useful for pre-9.5.11 vanish recovery).
- Solving the bridge `TRANSCRIPT_TERMINAL_MISSING` regression observed during the @gcp collab attempt for this slice — separate investigation (file as 9.5.12 or 9.6 depending on scope).

---

## Verification

- `npm run typecheck` → green
- `npm run lint` → 0 errors
- `npm test` → 9924 + 4 new tests = 9928 passing, 0 failing
- Cross-host bridge smoke test post-merge confirms channel mention dispatch unaffected.

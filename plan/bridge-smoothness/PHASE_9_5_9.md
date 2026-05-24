# Phase 9.5.9 — Anti-Stale-State + Channel-State Robustness

**Date:** 2026-05-24
**Branch:** `proj/channel-protocol` (HEAD `c4ee1135b`)
**Driving incident:** 2026-05-24 retest session where the laptop daemon ran pre-9.5.7 code for hours because `npm run build` updates dist on disk but Node's `require()` cache holds the old modules in memory. Every "live test" we did against the fixes was actually against the OLD pre-fix code. Symptoms looked like fresh regressions; cause was a stale daemon. We didn't catch it until cross-referencing the daemon's `startedAt` timestamp against the 9.5.7 commit time. ~6 hours of investigation went into chasing symptoms before identifying the real cause.

## 1. Why this slice exists

Five distinct pain points surfaced in 2026-05-24 testing:

1. **Stale daemon after rebuild.** Biggest one. Daemon process running since 08:45 local kept executing pre-9.5.7 code from its in-memory module cache, even after `dist/` was rebuilt at 14:14. No warning, no symptom that pointed at this. We saw "8-minute timeout" failures and assumed they were new bugs in 9.5.7/9.5.8 — they were old bugs the new code never executed against.

2. **`channel:list` fails the whole call on one bad meta.** Already documented in [orchestrator.ts:2126-2132](../../src/server/infra/channel/orchestrator.ts) as a tracked follow-up: *"The underlying listChannels tolerance bug is tracked as a follow-up."* Hit it today — a single legacy `auth-rotation` meta from 2026-05-05 (pre-current-schema) failed strict zod validation, returning what looked like "all channels gone."

3. **Partial auto-create records.** Phase 9.5.4 auto-create writes `remote-peer` members with `addressability='bootstrap-only'` but doesn't populate `multiaddr`/`remoteL2PubKey`. Schema marks those fields optional so the WRITE succeeds, but readers later choke. Operator-visible as "members invisible until manual re-pair."

4. **`.brv/` directory vanishing.** Root cause still unknown. Today the byterover-cli project's entire `.brv/` directory disappeared wholesale between sessions. We have zero instrumentation around `.brv/` lifecycle, so we can't tell who deleted it.

5. **`BRV_BRIDGE_*` env vars don't fully persist.** `bridge-config.json` captures `parleyProfile`, `listenAddrs`, `autoProvision`, `delegatePolicy`, `maxConcurrentPerProfile`. It does NOT persist `BRV_BRIDGE_CLAUDE_UNSAFE`, `BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS`, `BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS`. So a daemon respawn that loses env loses those settings silently. We worked around this with systemd on the VM; the laptop doesn't have that workaround.

The first one — stale daemon — is the leverage point. It made every other symptom misdiagnose-able. Today's investigation cost ~6 hours that build-version stamping would have surfaced in 3 seconds.

## 2. The five fixes

### 2.1 Fix #1a — Build-version stamping + client-side mismatch detection

**Goal:** when the laptop runs any `brv` CLI command against a daemon that's older than the on-disk dist, print a loud warning.

**Codex round-1 correction:** the original draft generated `src/server/utils/build-version.ts` as a POSTBUILD step — but `tsc` has already compiled, so `dist/` still contains the OLD stamp. Fix: generate a **separate runtime artifact** that both daemon and CLI read at startup. The dist tree never carries a build-time-baked constant; the runtime artifact is the source of truth, and there's no timing race.

**New file:** `dist/build-info.json` (generated, not committed)

```json
{
  "buildId": "2026-05-24T14:14:00Z-c4ee1135b-clean",
  "buildAtIso": "2026-05-24T14:14:00Z",
  "gitSha": "c4ee1135b",
  "gitDirty": false,
  "packageVersion": "3.15.1"
}
```

`buildId` is the canonical compare key (timestamp + SHA + clean/dirty flag). Mismatch detection compares `buildId` strings — exact match means the daemon and CLI were both built from the same artifact. The other fields are for human-readable logging.

**New file:** `scripts/generate-build-info.ts`.

**Codex round-2 correction:** the existing `npm run build` script starts with `shx rm -rf dist` — running `generate-build-info` as `prebuild` would write the file then immediately have it deleted. Solution: **bake the generation step into the build chain AFTER the rm but BEFORE tsc.** Concretely, update `package.json` to:

```json
"build": "shx rm -rf dist && node scripts/generate-build-info.js && tsc -b && shx cp -r src/server/templates dist/server/templates && shx cp -r src/agent/resources dist/agent/resources && npm run build:ui"
```

The order — `rm -rf dist` → `mkdir dist + write build-info.json` → `tsc` (which respects existing dist files) → `cp templates` → `build:ui` — is explicit and deterministic. The build-info.json survives every subsequent step. Reads `git rev-parse HEAD`, `git diff --quiet` (for dirty flag), `package.json.version`. If git isn't available, omits SHA/dirty fields and uses `package.version + timestamp` for the buildId.

```ts
// scripts/generate-build-info.ts
import {execSync} from 'node:child_process'
import {writeFileSync, mkdirSync} from 'node:fs'
import {join} from 'node:path'

const outDir = join(__dirname, '..', 'dist')
mkdirSync(outDir, {recursive: true})

let gitSha: string | undefined
let gitDirty = false
try {
  gitSha = execSync('git rev-parse --short HEAD').toString().trim()
  execSync('git diff --quiet')
} catch (err) {
  // either git missing or working-tree dirty
  if (gitSha) gitDirty = true
}

const buildAtIso = new Date().toISOString()
const pkg = JSON.parse(require('fs').readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
const buildId = `${buildAtIso}-${gitSha ?? 'nogit'}-${gitDirty ? 'dirty' : 'clean'}`

writeFileSync(join(outDir, 'build-info.json'), JSON.stringify({
  buildAtIso,
  buildId,
  gitDirty,
  gitSha,
  packageVersion: pkg.version,
}, null, 2))
console.log(`[build] wrote dist/build-info.json — buildId=${buildId}`)
```

**Daemon side:** at startup, reads `dist/build-info.json` once into a module-level constant. Exposes via new transport event `system:build-info`.

**Client side:** the CLI also reads `dist/build-info.json` at process start. After connecting to the daemon, calls `system:build-info`, compares `buildId`. On mismatch (any difference at all), print to stderr exactly once per CLI process:

```text
⚠ Daemon is running an older build than your CLI.
  Daemon buildId: 2026-05-24T08:45:00Z-1abbe7a58-clean
  CLI buildId:    2026-05-24T14:14:00Z-c4ee1135b-clean

  Node's require() cache holds the daemon's in-memory modules; rebuilt
  dist files do NOT take effect until the daemon restarts. Run:

      brv restart

  to pick up the latest code. Until then, daemon behavior may not match
  the code you can read in src/ or dist/.
```

**Codex round-1 correction (centralization):** the warning MUST be wired into the COMMON daemon-connection path, not just `withDaemonRetry`. The brv REPL/TUI uses `ensureDaemonRunning` + `startRepl`. MCP, webui have their own connect paths. Concretely: wrap the `system:build-info` check in a helper `assertBuildVersionMatch(daemonConn): Promise<void>` that runs on EVERY first daemon connection from a fresh process, regardless of which entry point made it. Call sites: `daemon-client.ts` connect, `channel-client.ts` connect, MCP server boot, webui-server boot, REPL `startRepl`. The check itself is idempotent and cheap; centralizing keeps coverage uniform.

**Files:** ~80 LOC daemon-side + ~50 LOC client-side check + ~50 LOC `scripts/generate-build-info.ts` + `package.json` wiring + ~5 tests (mismatch detected, match silent, missing build-info graceful, fatal-mode env). ~185 LOC total.

### 2.2 Fix #1b — `npm run build` post-step that flags running daemon

Even simpler signal: after `tsc` finishes, run a script that reads `<dataDir>/daemon.json` (`pid` + `startedAt`). If the file exists AND the PID is alive AND `startedAt < (now - 60s)` (i.e., daemon predates this rebuild), print:

```text
ℹ Build complete. NOTE: daemon (PID 12128) started before this build at <timestamp>.
  Daemon is still running OLD code in memory. Run 'brv restart' to apply changes.
```

**Files:** new `scripts/check-daemon-staleness.ts`. ~30 LOC. Wired as `"postbuild": "node scripts/check-daemon-staleness.js"` in `package.json`.

Independent of 2.1 — useful even if the user doesn't connect via CLI yet (e.g., during a long dev iteration).

### 2.3 Fix #1c — Dev-mode auto-restart on build

Optional escape hatch for fast iteration. When `BRV_ENV=development`, `npm run build` chains into `npm run dev:kill` automatically. New script:

```json
"scripts": {
  "build:dev": "npm run build && npm run dev:kill",
  "rebuild": "npm run build:dev"
}
```

Or alternatively, add `--auto-restart` flag to the existing build script. ~5 LOC change to `package.json`.

### 2.4 Fix #2 — `listChannels` skip-not-fail tolerance

**File:** `src/server/infra/channel/channel-store.ts:168` (`listChannels`).

The orchestrator's `runProjectWarm` at [orchestrator.ts:2125-2155](../../src/server/infra/channel/orchestrator.ts) already uses the right pattern. Mirror it in the user-facing endpoint:

```ts
async listChannels(args: ChannelStoreListArgs): Promise<Channel[]> {
  const channelsRoot = channelPaths.channelsRoot(args.projectRoot)
  let entries: string[]
  try {
    entries = await fs.readdir(channelsRoot)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  const results = await Promise.allSettled(
    entries.map(async (channelId) => this.readChannelMeta({channelId, projectRoot: args.projectRoot})),
  )

  const channels: Channel[] = []
  for (const [i, r] of results.entries()) {
    if (r.status === 'fulfilled' && r.value !== undefined) {
      if (args.archived !== undefined && (r.value.archivedAt !== undefined) !== args.archived) continue
      channels.push(projectMetaToChannelWire(r.value))
    } else if (r.status === 'rejected') {
      this.log(`[channel-store] listChannels skipping malformed meta ${entries[i]}: ${r.reason}`)
    }
  }
  return channels
}
```

**Files:** ~40 LOC change in `channel-store.ts` + ~3 tests covering (a) clean list, (b) one bad meta skipped, (c) all bad metas return empty.

### 2.5 Fix #3 — Mark partial auto-create members as unusable, not refuse the write

**Codex round-1 correction:** the original draft refused the write entirely. That breaks the existing intentional design where the schema allows mirror-only members — channel-doctor already has a `MIRROR_ONLY` health code for exactly this case. Refusing the write would create turns/deliveries whose member handle is missing from the channel meta, which is a worse asymmetry. Better: persist the partial member with an explicit unusable marker that warm/list/doctor surface clearly.

**File:** `src/server/infra/channel/bridge/bridge-transcript-service.ts`.

When the bridge auto-creates a `remote-peer` member from an inbound parley AND either `multiaddr` OR `remoteL2PubKey` is missing, write the member with:

- `addressability: 'inbound-only'` (new literal value alongside existing `'bootstrap-only'` and `'pinned'`)
- The partial fields that ARE known (peerId, handle, displayName, status)
- Explicitly NULL/absent `multiaddr` and `remoteL2PubKey`

Schema update in `src/shared/types/channel.ts`:

```ts
addressability: z.enum(['bootstrap-only', 'pinned', 'inbound-only']).optional()
```

`inbound-only` semantics: this peer reached US over libp2p, we accepted the parley, we have the verified peerId — but we don't have what's needed to reverse-dial them. The channel member appears in `brv channel list --json`, `brv channel show`, `brv channel doctor`, but with a clear marker so the operator knows reverse mention will fail until they `brv bridge connect <fresh-multiaddr>` to upgrade it.

**Consumer updates:**

1. **`RemoteMemberDriver.warmRemotePeerDriver`** ([orchestrator.ts:2248](../../src/server/infra/channel/orchestrator.ts)) — already skips members where multiaddr/L2 are missing. Tighten the log message: `[orch] remote-peer ${handle} is inbound-only (no multiaddr/L2) — reverse-dial impossible until brv bridge connect`.

2. **`channel-doctor`** ([doctor-service.ts](../../src/server/infra/channel/doctor-service.ts)) — already has `MIRROR_ONLY` code (codex confirmed). Extend it to emit a `INBOUND_ONLY` warning for `inbound-only` members specifically, with a recovery hint (`brv bridge connect <fresh-multiaddr>`).

3. **Orchestrator outbound-mention path** — when an outbound mention targets an `inbound-only` member, fail-fast with a clear error code `BRIDGE_INBOUND_ONLY_MEMBER` and the brv-bridge-connect recovery hint. Don't try to dial.

**Migration for existing partial records** (codex round-1: opportunistic, not quarantine): on daemon startup, scan all channel metas. Any `remote-peer` member with `addressability='bootstrap-only'` (or absent) AND missing `multiaddr` OR `remoteL2PubKey` gets the field upgraded to `'inbound-only'` (atomic write back). One-time migration; idempotent on subsequent runs because already-marked members get skipped.

**Files:** ~30 LOC in `bridge-transcript-service.ts` (auto-create writes the marker), ~20 LOC in `doctor-service.ts` (new INBOUND_ONLY code), ~15 LOC in orchestrator (outbound-mention guard), ~25 LOC in a new `migration-mark-inbound-only.ts` (opportunistic on-startup migration), schema field. ~90 LOC + 5 tests total.

### 2.6 Fix #4 — `.brv/` lifecycle observability (NOT attribution)

**Codex round-1 correction:** `fs.watch` cannot tell us WHO deleted `.brv/` — only that the daemon observed it deleted. The original draft's stack-trace-on-delete is observability dressed up as attribution. Soften the framing: this is purely observability. When `.brv/` vanishes again, we'll have a timestamp and a daemon-side log line that says "I noticed this disappeared," not evidence of which process did the rm. That still helps narrow the search (daemon → external tool boundary), but we don't claim to identify the deleter.

**File:** `src/server/utils/brv-dir-watcher.ts` (new).

At daemon startup, register `fs.watch` on `<projectRoot>/.brv/` (lifecycle events only by default; verbose all-writes mode behind `BRV_DEBUG_DIR_WATCH=1` env per codex's answer to Q3). Also watch the PARENT directory (`<projectRoot>/`) with a separate watcher specifically to catch the `.brv/` directory itself being deleted (the recursive watcher dies the moment its root is removed).

```ts
// Pattern — lifecycle events only:
const lifecyclePaths = new Set([
  'context-tree',
  'context-tree/channel',
  'channel-history',
])

fs.watch(brvDir, {recursive: true}, (eventType, filename) => {
  if (eventType !== 'rename') return
  if (!filename) return

  // Only log lifecycle-meaningful paths unless verbose mode is on.
  const isLifecycle = lifecyclePaths.has(filename)
    || filename.match(/^context-tree\/channel\/[^/]+\/?$/)
    || filename === 'context-tree/channel'
  if (!isLifecycle && process.env.BRV_DEBUG_DIR_WATCH !== '1') return

  const fullPath = path.join(brvDir, filename)
  fs.access(fullPath).then(
    () => log(`[brv-dir] created ${filename}`),
    () => {
      // Deletion. Use WARN for any context-tree/channel path; INFO for others.
      if (filename.startsWith('context-tree/channel/') || filename === 'context-tree/channel') {
        // Codex round-2 correction: the watcher cannot tell whether the daemon
        // OR an external tool caused the deletion. Don't claim either way.
        log.warn(`[brv-dir] OBSERVED deletion of channel state at ${filename} (daemon PID=${process.pid}); cause unknown — check daemon logs + external tools (IDE sync, git operations, manual rm).`)
      } else {
        log(`[brv-dir] observed deletion of ${filename}`)
      }
    },
  )
})

// Parent watcher — catches .brv/ itself being deleted
fs.watch(path.dirname(brvDir), {recursive: false}, (eventType, filename) => {
  if (filename === '.brv' && eventType === 'rename') {
    fs.access(brvDir).catch(() => {
      log.error(`[brv-dir] OBSERVED deletion of ENTIRE .brv/ directory at ${brvDir}. Daemon will not detect future channel writes until restart + recreation.`)
    })
  }
})
```

This is observability, not attribution. We don't claim the daemon caused (or didn't cause) the deletion — only that we saw it.

**Defensive reconstruction (separate, additive):** at daemon startup, scan `.brv/channel-history/<id>/` directories. For each that exists but lacks a corresponding `.brv/context-tree/channel/<id>/meta.json`, reconstruct a minimal meta from the first turn's `_recordType: 'snapshot'` line in the index (or from the earliest turn-snapshot file). Loud INFO log on every reconstruction so the operator knows the daemon noticed + auto-fixed.

**Files:** new `src/server/utils/brv-dir-watcher.ts` (~70 LOC), new `src/server/utils/channel-meta-reconstruction.ts` (~35 LOC), wired in daemon startup, ~4 tests. ~120 LOC total.

### 2.7 Fix #5 — Persist all `BRV_BRIDGE_*` env vars to `bridge-config.json`

**File:** `src/server/infra/channel/bridge/bridge-config-store.ts`.

Today's `BridgePersistedConfigSchema` covers `parleyProfile`, `listenAddrs`, `autoProvision`, `delegatePolicy`, `maxConcurrentPerProfile`. It does NOT cover:

- `BRV_BRIDGE_CLAUDE_UNSAFE` — critical for Claude Code adapter registration. Earlier in the session we hit `PARLEY_LOCAL_AGENT_PROFILE_MISSING` because the daemon respawned without this in env.
- `BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS` — Phase 9.5.7 split-timeout config.
- `BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS` — Phase 9.5.7 split-timeout config.
- `BRV_BRIDGE_PARLEY_HARD_TIMEOUT_MS` (if/when we add hard cap).
- `BRV_BRIDGE_AUTO_CREATE_QUOTA` — Phase 9.5.4 quota config.

Extend the schema with optional fields for each. Update `resolveBridgeRuntimeConfig` to read env first (existing behavior) and persist back to file. Subsequent respawns inherit even without env in scope.

**Files:** ~50 LOC in `bridge-config-store.ts` + 4 tests (one per new field).

## 3. Implementation order

Reordered per codex round-1: **build-version stamping ships FIRST**, because without it every subsequent live retest can still lie about which code is running. Six hours of the 2026-05-24 session were lost to that exact misdiagnosis.

| # | Fix | LOC (revised) | Risk | Ship order rationale |
|---|---|---|---|---|
| 2.1 | Build-version stamping + client warning | ~185 | Low | THE leverage fix. Ships first so every later retest is honest about which code is running. |
| 2.2 | Post-build daemon-staleness check | ~30 | Low | Belt + suspenders for 2.1. Catches the dev who doesn't connect via CLI before noticing. |
| 2.4 | `listChannels` skip-not-fail | ~40 | Low | Stops the "channels gone" symptom for legacy/malformed metas. Same pattern as `runProjectWarm` — proven. |
| 2.7 | Persist all `BRV_BRIDGE_*` to bridge-config.json | ~50 | Low | Closes the env-loss gap. Removes systemd dependency on the laptop. |
| 2.5 | Accept-but-mark partial auto-create as `inbound-only` | ~90 | Low | Stops the "auto-create writes invisible members" class of bug. Includes opportunistic migration for existing partial records. |
| 2.6 | `.brv/` lifecycle observability + defensive reconstruct | ~120 | Low-Med | Observability for the still-mysterious `.brv/` vanish + auto-reconstruct meta from channel-history. |
| 2.3 | Dev-mode auto-restart on build | ~5 | Low | Convenience. Nice to have. |

Total: ~520 LOC + ~25 tests. ~1.5-2 days of focused implementor + codex + kimi review work (revised up from initial ~295 estimate because of codex round-1 expansion on 2.1 and 2.5).

## 4. Tests

- Unit tests for each fix as outlined above.
- **Integration test for 2.1** (codex round-2 — updated for runtime-artifact design): start a daemon (which reads `dist/build-info.json` at boot). Overwrite `dist/build-info.json` on disk with a new buildId (simulate a rebuild). Send a `system:build-info` request — assert the response still shows the OLD buildId (proves daemon cached the boot value, doesn't re-read). Start a fresh CLI process — assert it reads the NEW buildId from disk, calls `system:build-info`, detects mismatch, and prints the staleness warning to stderr exactly once.
- **Integration test for 2.4:** create a channel with a malformed meta + 3 valid metas. `listChannels` returns 3, logs 1 skip.
- **Integration test for 2.6:** start daemon, `rm -rf .brv/context-tree/channel/foo/` mid-run — assert the WARN log fires with the right path.

## 5. Codex Round-1 — Resolutions

Reviewer: codex on 2026-05-24, turnId `A0epTiAUu2hV6kIxWULeM` (133s). Verdict: **block as written, but the seven-fix shape is right.** Three plan edits + answers to all five open questions. All resolved in this revision:

| # | Codex round-1 finding | Resolution |
|---|---|---|
| 1 | §2.1 build-stamp timing bug — `postbuild` runs AFTER `tsc`, so dist still has the old stamp | §2.1: generate `dist/build-info.json` as a **runtime artifact** (read at startup), NOT a compiled-in constant. **Build-chain step after `rm -rf dist`** (NOT `prebuild`, which would also be deleted) writes the file via `scripts/generate-build-info.ts`. Daemon AND CLI read it at process boot. No timing race. |
| 2 | §2.1 warning placement — `withDaemonRetry` doesn't cover REPL/TUI/MCP/webui entry points | §2.1: centralized `assertBuildVersionMatch(daemonConn)` helper called from EVERY first-connection path (daemon-client connect, channel-client connect, MCP boot, webui boot, REPL `startRepl`). Idempotent + cheap; coverage uniform. |
| 3 | §2.5 should be accept-but-mark, not refuse — `MIRROR_ONLY` doctor code already designed for this case; refusing the write creates worse asymmetry (turns/deliveries with absent member handles) | §2.5: persist the partial member with new `addressability='inbound-only'` literal. Doctor surfaces `INBOUND_ONLY` warning. Orchestrator's outbound-mention path fails fast with copy-paste recovery hint. Opportunistic startup migration upgrades existing partial records (not quarantine). |

### Codex round-1 direct answers (all incorporated)

1. **Build-version source:** **both** (and more). Store `packageVersion`, `gitSha`, `gitDirty`, `buildAtIso`, derived `buildId`. Compare on `buildId` (the canonical key). Other fields for human-readable logging. ✓ §2.1
2. **Postbuild check fatal vs warning:** **warning** by default. Opt-in fatal mode via env (`BRV_BUILD_STRICT=1`). ✓ §2.2
3. **`.brv/` watcher scope:** **lifecycle events by default**, verbose all-writes behind `BRV_DEBUG_DIR_WATCH=1` env. Also watch parent dir so `.brv/` deletion itself is visible (recursive watcher dies the moment its root is removed). ✓ §2.6
4. **Partial auto-create:** **accept-but-mark** as `inbound-only`. Existing `MIRROR_ONLY` doctor code is the right family of design. ✓ §2.5
5. **Schema versioning:** with accept-but-mark, **opportunistic migration** annotates existing partial records on daemon startup. No quarantine needed — valid history stays valid. ✓ §2.5

### Codex's explicit disagreement (incorporated)

**§2.6 overclaim:** `fs.watch` cannot tell us WHO deleted `.brv/` — only that the daemon observed it deleted. The original draft's "log with stack trace" implied attribution; reality is pure observability. §2.6 now explicitly says the daemon "did NOT do this" in the warn message (when the daemon notices a delete it didn't cause) and frames it as a search-narrowing tool, not a perpetrator-identification one.

### Codex Round-2 — Resolutions

Reviewer: codex on 2026-05-24, turnId `Qglm4CWQsdwGa9wZrwavh` (34s). Verdict: **two more plan blockers + answers to all three open questions.** All resolved in the current revision:

| # | Codex round-2 finding | Resolution |
|---|---|---|
| 1 | §2.1 build ordering trap — `shx rm -rf dist` runs first and would delete a prebuild-written file | §2.1: bake generation INTO the build chain AFTER the rm: `shx rm -rf dist && node scripts/generate-build-info.js && tsc -b && shx cp ... && npm run build:ui`. Order is explicit + deterministic; build-info.json survives every subsequent step. |
| 2 | §2.6 still overclaims attribution — daemon may be the deleter; watcher can't prove either way | §2.6: wording softened to `OBSERVED deletion ... cause unknown — check daemon logs + external tools (IDE sync, git operations, manual rm)`. No claim about who did it. |
| 3 | §4 test text still references old design's `dist/server/utils/build-version.js` | §4: integration test now reads + overwrites `dist/build-info.json`, asserts cached-vs-fresh comparison correctly. |

### Codex round-2 direct answers (all incorporated)

1. **`buildId` granularity:** **millisecond ISO is enough** — `new Date().toISOString()` produces ms precision natively. No counter needed. Two builds in the same ms on the same SHA is implausible at human speeds; even back-to-back `npm run build` invocations differ by hundreds of ms.
2. **`assertBuildVersionMatch` placement:** **layered.** Pure read/compare/format utilities go in `src/shared/build-info-check.ts` (no transport types, no oclif/server imports — keeps shared/ clean). Transport-specific "call `system:build-info` and warn once" wrappers live near daemon-client / channel-client / MCP-boot / webui-boot connection code. Each connection-layer module imports the pure utilities from shared.
3. **§2.5 migration safety:** **use the existing channel meta write serializer / per-channel meta lock.** The codebase already has a per-meta atomic write path (the same one `bridge-config-store` uses). The opportunistic migration step calls into THAT serializer rather than rolling its own. Idempotent and atomic per meta file.

### Codex's sign-off condition

> "After those edits, I'd sign off on the plan."

The three blockers are now patched. The three open questions are answered + applied. Ready for the implementor pass.

## 6. Out of scope (tracked but deferred)

- Daemon-level SIGTERM/SIGINT registry for in-flight abort propagation (codex round-3 deferral from 9.5.7).
- Libp2p ping hardening as a periodic-call helper (codex round-2 deferral from 9.5.7).
- Responder-side `BridgeTranscriptService` broadcaster wire-up (codex round-1 deferral from 9.5.4).
- Cross-bridge permission flow (the headless-claude `--dangerously-skip-permissions` opt-in gate).

## 7. References

- Phase 9.5.7 — `plan/bridge-smoothness/PARLEY_TIMEOUT_FIXES.md`
- Phase 9.5 master plan — `plan/bridge-smoothness/PLAN.md`
- 2026-05-24 driving bug report — `plan/channel-protocol/BUG_REPORT_PARLEY_TIMEOUTS_2026-05-24.md`
- Orchestrator's existing TODO comment — `src/server/infra/channel/orchestrator.ts:2126-2132`
- Today's full investigation trail — this session's conversation transcript

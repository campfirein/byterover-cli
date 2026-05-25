# Bridge Smoothness Plan

**Branch:** `proj/channel-protocol` (Phase 9.5)
**Owner:** Andy
**Date:** 2026-05-23

## 1. Why

Phase 9 ships the cross-machine bridge. Live two-machine internal test on 2026-05-22 surfaced six concrete operator-UX defects (§3). Three of them block the demo we want: **Claude Code on the VM should auto-pick-up an inbound mention, do real work, reply across the bridge — without a human paste-prompt loop.** Today only ACP-native agents (codex/kimi/opencode/gemini) can drive a parley call; Claude Code is non-ACP and there is no in-daemon path for it.

This plan covers two things:

1. **Parley adapter abstraction (§2).** Generalise the existing single-path dispatcher (`mockEchoChunks` ∨ `createLocalAgentResponseGenerator`) into a typed registry. First non-ACP adapter is Claude Code via `claude -p --resume --output-format stream-json` headless. Future adapters (Aider, gemini-cli without acp, custom shells) drop into the same registry.

2. **Bridge UX smoothness (§3).** Address the six friction points we hit in live test so the second internal-tester doesn't repeat our pain. Most are small targeted fixes; the largest is "one-command connect" replacing the current pin → invite → verify ceremony.

## 2. Parley Adapter Abstraction

### 2.1 Current state (from code research)

- `src/server/infra/channel/bridge/parley-server.ts:165` already accepts a `responseGenerator: ParleyResponseGenerator` injection.
- `mockEchoChunks` is the default fallback (line 165).
- The ACP path lives behind `createLocalAgentResponseGenerator(...)` wired in `brv-server.ts:965`.
- The shape `async function*({envelope, ...}) → yields ParleyChunk` is already the de-facto adapter interface; we just need to formalise it, namespace by profile name, and let operators select via `--profile <name>` at invite time or via env at daemon start.

So the abstraction is **mostly a rename + a registry + one new adapter**. It is not a rewrite.

### 2.2 Interface

```ts
// src/server/infra/channel/bridge/parley-adapter.ts
export interface ParleyAdapter {
  /** Stable profile name, used by --profile / BRV_BRIDGE_PARLEY_PROFILE. */
  readonly profile: string

  /** What this adapter is. Used by `brv channel doctor`. */
  readonly kind: 'acp' | 'sdk-headless' | 'mock' | 'shell-template'

  /**
   * Produce response chunks for a single inbound parley query.
   * Implementations MUST NOT touch the channel store; the parley-server
   * handles transcript writes through BridgeTranscriptService.
   * On terminal failure throw `ParleyResponseError(code, message)`; the
   * parley-server owns transcript_seal emission and converts the throw
   * into the appropriate sealed error frame. Adapters MUST NOT emit
   * transcript_seal directly.
   */
  generate(args: ParleyAdapterContext): AsyncIterable<ParleyChunk>

  /**
   * Optional warm-up. Returns a typed availability result; if the adapter
   * can't run (e.g. the `claude` binary is missing on PATH for the SDK
   * headless adapter), return `{available: false, reason}`. The daemon
   * logs this at startup and `brv channel doctor` surfaces it. Throwing
   * is allowed for hard failures (corrupt state, etc.).
   */
  warm?(args: AdapterWarmArgs): Promise<AdapterWarmResult>
  shutdown?(): Promise<void>
}

export type AdapterWarmResult =
  | {readonly available: true}
  | {readonly available: false; readonly reason: string}

export interface ParleyAdapterContext {
  readonly channelId: string
  readonly senderPeerId: string          // verified peerId from handshake
  readonly senderHandle: string          // display handle if known, else '' — DO NOT use as a persistence key
  readonly turnId: string
  readonly envelope: ParleyQueryEnvelope // includes promptBlocks + senderL2Pub
  readonly abortSignal: AbortSignal      // MUST be the stream-lifecycle signal, not a stub
  readonly logger: (msg: string) => void
  readonly projectRoot: string           // for path-scoped persistence keys
}
```

**`abortSignal` is required, not optional.** The current refactor wraps it in a never-aborted stub (`parley-server.ts:146`) — that's a phase-9.5.2 stub. Phase 9.5.3 (the ClaudeCodeHeadlessAdapter) MUST plumb the real libp2p stream lifecycle signal through, so an aborted client (Ctrl-C on Alice's side, daemon shutdown, libp2p stream close) actually kills the headless subprocess. Subprocess hang on a dead substream is a real risk without this.

### 2.3 Registry

```ts
// src/server/infra/channel/bridge/parley-adapter-registry.ts
export interface ParleyAdapterRegistry {
  register(adapter: ParleyAdapter): void
  resolve(profile: string): ParleyAdapter | undefined
  list(): readonly Pick<ParleyAdapter, 'profile' | 'kind'>[]
}

export function createDefaultRegistry(args: {
  readonly bridgeDriverPool: BridgeDriverPool          // for acp adapter
  readonly channelDriverFactory: ChannelDriverFactory  // for acp adapter
  readonly profileStore: ProfileStore                  // resolves connector → invocation
  readonly stateDir: string                            // for session-id persistence
  readonly log: (msg: string) => void
}): ParleyAdapterRegistry {
  const r = new InMemoryParleyAdapterRegistry()
  r.register(new MockEchoAdapter())
  r.register(new AcpAdapter({pool: args.bridgeDriverPool, ...}))
  r.register(new ClaudeCodeHeadlessAdapter({stateDir: args.stateDir, log: args.log}))
  return r
}
```

Resolution at daemon startup (`brv-server.ts`):

```ts
const registry = createDefaultRegistry({...})
const profile = bridgeRuntime.parleyProfile // env > file > undefined

// Strict resolution. An EXPLICIT profile that doesn't resolve is a
// configuration error, not a fall-back-to-mock-echo case — silently
// degrading a real bridge to echo masks misconfigurations and was
// flagged in plan review (codex 2026-05-23).
let adapter: ParleyAdapter
if (profile === undefined) {
  adapter = registry.resolve('mock-echo')! // unset profile → mock-echo
} else {
  const resolved = registry.resolve(profile)
  if (resolved === undefined) {
    throw new ParleyAdapterNotFoundError(profile, registry.list())
  }
  adapter = resolved
}
log(`[Daemon] Parley adapter: ${adapter.profile} (kind=${adapter.kind})`)
```

The inbound `/brv/parley/query/v1` path also re-resolves per query so a hot-reloaded registry (test fixture, future plugin) takes effect without a daemon restart. The miss-case there still throws `ParleyResponseError('PARLEY_ADAPTER_NOT_FOUND', ...)` so the sender sees a signed terminal seal, not a stuck stream.

### 2.4 Built-in adapters

| Adapter | Drives | Subprocess shape | Session reuse |
|---|---|---|---|
| `MockEchoAdapter` | tests + default-off | inline async generator | n/a |
| `AcpAdapter` | codex, kimi, opencode, gemini, custom acp.json | wraps `BridgeDriverPool.acquire(profile, factory)` | per-pool driver |
| `ClaudeCodeHeadlessAdapter` | Claude Code | `claude -p <prompt> --resume <sessionId> --output-format stream-json --allowed-tools ...` | session-id persisted under composite key `${projectRoot}\0${channelId}\0${senderPeerId}\0${adapterProfile}` (see §2.5 for atomicity requirements) |
| `ShellTemplateAdapter` | future / custom CLIs | configurable template + stdout capture | none |

### 2.5 ClaudeCodeHeadlessAdapter — detail

Why this adapter exists: Claude Code is not ACP-native. The bridge needs a parley dispatcher that can spawn `claude` headless, pipe the inbound prompt as input, parse `stream-json` output, and emit channel events.

**⚠️ Security gate — opt-in only.** The headless adapter spawns `claude -p --dangerously-skip-permissions`, which lets a verified remote prompt drive Bob's local Claude Code with Bob's filesystem and process permissions. Until §3.7 (permission passthrough) lands, this adapter is registered **only** when `BRV_BRIDGE_CLAUDE_UNSAFE=1` is set in the daemon environment. The startup log and `brv channel doctor` both surface a `claude-code (UNSAFE — no permission gate)` warning when this is active. Operators should run the adapter only on a dedicated VM/sandbox they are willing to hand to a verified peer. Default-off prevents demos from accidentally shipping the security hole.

**Subprocess invocation** (per inbound turn):

```bash
claude -p "<flattened envelope.prompt[*].text>" \
  --resume <stored-session-id-or-omit> \
  --output-format stream-json \
  --dangerously-skip-permissions \
  --cwd <project-root-for-channel>
```

`stream-json` event mapping → `ParleyChunk`:

| stream-json event | ParleyChunk kind |
|---|---|
| `assistant` (text delta) | `agent_message_chunk` |
| `tool_use` | `agent_thought_chunk` (for now; deferred permission flow in §3.7) |
| `result` (final, success) | end of stream, persist new `session_id` |
| `error` / non-zero exit | throw `ParleyResponseError('ADAPTER_SUBPROCESS_FAILED', stderr)`. Parley-server owns the terminal seal frame; adapters never emit `transcript_seal` directly. |

**Session persistence:** **NOT a flat `${channelId}\0${memberHandle}` key — that collides across projects and adapter profiles.** Two acceptable shapes:

- **Preferred — channel-meta colocation.** Extend the per-channel-member meta with an optional `adapterState: {profile: string; sessionId: string}` field. Lifecycle (uninvite, channel delete) cleans up the session id automatically; no GC tax.
- **Acceptable for the demo cut — sidecar.** `<dataDir>/state/parley-adapter-sessions.json` keyed by the composite `${projectRoot}\0${channelId}\0${senderPeerId}\0${adapterProfile}` (NOT `senderHandle` — display handles can be empty or change). Requirements: `0600` perms on creation, atomic temp-file + rename writes, an in-process write mutex, stale-entry GC (delete keys whose channelId no longer exists), and the composite key MUST be derived from the verified peerId from the parley handshake, not from the adapter context's display fields.

The plan ships with the sidecar path under the strict requirements above; channel-meta colocation lands in a follow-up cleanup pass once the schema migration is non-blocking.

**Concurrency.** `BridgeDriverPool` is typed for `IAcpDriver` warm reuse and does NOT generalise to spawn-per-turn subprocesses (codex correctly flagged this — `bridge-driver-pool.ts:35`). Introduce a separate `ProfileConcurrencyGate` semaphore keyed by adapter profile name, honouring the existing `BRV_BRIDGE_MAX_CONCURRENT_PER_PROFILE` env. The ACP adapter keeps using `BridgeDriverPool`; the headless adapter uses the gate only. Both knobs share the same env var so operators don't see a behaviour split.

**Failure modes the adapter must handle:**

| Failure | Mapping |
|---|---|
| `claude` not on PATH | `warm()` returns `{available: false, reason: 'claude binary not on PATH'}`; daemon logs + `brv channel doctor` surface it |
| `BRV_BRIDGE_CLAUDE_UNSAFE` unset | adapter is not registered at all; `BRV_BRIDGE_PARLEY_PROFILE=claude-code` hard-fails at startup with the missing-env hint |
| Subprocess exits non-zero | adapter throws `ParleyResponseError('ADAPTER_SUBPROCESS_FAILED', stderr-tail)`; parley-server writes the sealed error frame |
| Stale session-id (claude rejects `--resume`) | drop session-id, retry once without `--resume`, persist new id; if retry also fails, propagate as `ADAPTER_SUBPROCESS_FAILED` |
| Stream lifecycle aborted (Alice Ctrl-C, daemon shutdown) | `abortSignal` fires → adapter sends `SIGTERM` to the subprocess, drains stdout, returns without throwing. Parley-server emits cancel seal. |

### 2.6 Migration — phased

1. **Refactor + delete duplicate path.** Extract `ParleyAdapter` interface + registry. Move `mockEchoChunks` and `createLocalAgentResponseGenerator` behind it — and **delete `local-agent-response-generator.ts` in the same PR** once `AcpAdapter` is the sole caller. Codex correctly flagged that leaving both the legacy function and the new `AcpAdapter` in the tree means we've added abstraction tax without reaping the simplification benefit. The 9.5.2 scaffold already in the working tree (committed via implementor) still has the duplicate path; the next pass on 9.5.2 must collapse it before 9.5.3 starts.
2. **Add `ClaudeCodeHeadlessAdapter`.** New file + tests. Daemon wiring unchanged because the registry already exists from step 1. Registered ONLY when `BRV_BRIDGE_CLAUDE_UNSAFE=1` (see §2.5 security gate).
3. **Connector metadata.** Extend the existing connectors registry (`brv connectors install ...`) so each agent declares its parley adapter type. `brv channel invite ... --profile claude-code` then "just works" because the daemon looks up the connector's parley-adapter declaration at invite time. *Out of scope for this PR — follow-up.*
4. **Permission/tool-call passthrough.** Map Claude Code `tool_use` events to bridge `permission_request` events so an operator on Alice's side can approve/deny Bob's tool calls. Removes the `BRV_BRIDGE_CLAUDE_UNSAFE` gate. *Out of scope — follow-up after the headless adapter lands, but tracked as a prerequisite for promoting the adapter from opt-in to default.*

## 3. Bridge UX Smoothness — Friction Fixes

Each fix below references the actual symptom seen on 2026-05-22.

### 3.1 Daemon respawn drops bridge listener

**Symptom:** After auto-spawn-on-CLI-call, the daemon respawned without re-binding to the persisted `listenAddrs`. `lsof :60001` showed no listener; cross-machine dials hit ECONNREFUSED. Workaround was `pkill brv-server && brv bridge whoami` to force re-init.

**Fix:** Make `ensureBridgeHost()` (currently lazy) run unconditionally at daemon startup when `bridge-config.json` has any persisted bridge state (listenAddrs OR parleyProfile OR pinned peers). Cost: a couple of seconds at daemon boot, paid once. Correctness: any subsequent CLI call hits a hot, bound bridge.

**Implementation:** in `brv-server.ts` startup, after `resolveBridgeRuntimeConfig`, if any bridge-side state is persisted, call `await host.start()` and `bindParleyServer(...)` synchronously rather than waiting for the first incoming `brv bridge whoami` / `brv channel invite` to trigger it.

**Test:** integration test that restarts the daemon with persisted bridge-config and asserts `lsof`-equivalent (port-bound check via `net.connect`) immediately after `brv` startup.

### 3.2 TOFU pin ceremony — `auto-tofu` vs `pinned-only`

**Symptom:** Bidirectional bridging required `brv bridge verify <peer>` on **both** sides to promote the auto-tofu pin to user-confirmed. Without it, the *receiver's* `pinned-only` auto-provision policy rejected inbound parley with `CHANNEL_AUTO_PROVISION_DECLINED`. The error message correctly tells the operator what to do, but the doc didn't, and "I have to verify the same peer twice on two machines" is a 2-machine-test footgun.

**Three fixes, layered:**

- **(a) Doc fix (INTERNAL_TEST.md).** Add an explicit "after pinning, run `brv bridge verify <peer>` on both sides before the first mention" step. Cheap. Ships immediately.
- **(b) `brv bridge pin` should offer a `--verify` flag** that pins + promotes in one shot when the operator has already eyeballed the multiaddr+peerId out-of-band (which is the realistic case during a Tailscale-mediated setup). Default off; explicit opt-in.
- **(c) `brv bridge connect <multiaddr>` new command** (see §3.6) bundles pin + verify + optional channel-invite. The one-command path that internal-testers should reach for.

### 3.3 Channels are per-daemon — invite from remote does not auto-create local mirror

**Symptom:** VM ran `brv channel new cc-chat` + invited `@laptop` (as remote-peer). Laptop's `brv channel list` did **not** show `cc-chat`. Laptop's `brv channel mention cc-chat ...` returned `CHANNEL_NOT_FOUND`. Workaround: laptop had to manually `brv channel new cc-chat` and `brv channel invite cc-chat @gcp --peer ... --multiaddr ...` symmetrically.

**State of play (codex flagged this):** the current code at `bridge-transcript-service.ts:364` already auto-creates a partial channel mirror under the policy gate. **But it only stores `peerId` + optional display name — no routable multiaddr and no L2 cert.** That means the laptop's mirror records the inbound, the operator sees the channel, but the laptop can't reverse-dial: a `brv channel mention <ch> @gcp ...` from the laptop side will hit `BRIDGE_DIAL_FAILED` because there's no `multiaddr` on the membership record. The fix has to address both creation AND addressability.

**Fix:**

- **Trust gate:** auto-create fires for `user-confirmed` and `ca-bound` peers only — never `auto-tofu`. Codex correctly flagged that auto-tofu auto-create gives a freshly-encountered peer the ability to spawn arbitrary channelIds on Bob without any human verification step.
- **Addressability:** the parley handshake already verifies the sender's peerId via the L2 cert. The auto-create path additionally:
  - Stores the multiaddr the inbound stream came from (best-effort — libp2p `connection.remoteAddr`) as the member's bootstrap multiaddr.
  - Fetches the sender's full L2 cert via `/brv/identity/cert/v1` on the same connection (it's already verified for the parley call; reusing the L2 key for member-record persistence is free).
  - Marks the membership as `addressability: 'bootstrap-only'` — explicit signal to the orchestrator that reverse-dial may need a `brv bridge connect` step to upgrade to a stable multiaddr.
- **Quotas + rate limits:** cap a single peer to N channels auto-created per hour (default `N=5`, configurable via `BRV_BRIDGE_AUTO_CREATE_QUOTA`); above that, return `PARLEY_AUTO_CREATE_RATE_LIMIT` and decline. Per-peer counter resets on operator-side `brv channel uninvite`.
- **`channelId` validation:** restrict auto-created channelIds to `^[a-z0-9][a-z0-9-]{0,63}$` (matches existing `brv channel new` rules); reject anything outside that pattern with `PARLEY_INVALID_CHANNEL_ID`. Prevents path-traversal or display-spoofing channel names.
- **Provenance:** record `autoProvisionedFrom: '<peerId>'` and `autoProvisionedAt: ISO timestamp` on the channel meta. `brv channel list --json` exposes both for operator audit.
- **Out-of-band event:** emit a `channel_auto_created` event on the daemon's event bus so an external watcher (subscribed via `brv channel subscribe --kinds channel_auto_created`) reacts in real time. This is the foundation for "Claude Code on VM auto-picks-up": the headless adapter from §2.5 subscribes to this kind and warms its session-id cache for the new channel.

**Failure recovery:** if the bootstrap multiaddr later becomes stale (peer rebound on a new port), the orchestrator surfaces a `BRIDGE_MULTIADDR_STALE` error code on the next outbound mention, with a copy-paste-ready `brv bridge connect <fresh-multiaddr>` hint in the error message. We do not silently swap multiaddrs — that would defeat the trust posture.

### 3.4 Multiaddr interface annotation

**Symptom:** Two macOS Tailscale entries (current "nguyens-macbook-pro-4" `100.120.188.62` and stale "mac" `100.84.167.73`). `brv bridge whoami` listed both as bare multiaddrs; the VM ended up pinning the stale one. Tailscale ICMP worked (DERP-relayed) but TCP routing went to the wrong device.

**Fix:** annotate `brv bridge whoami --format json` output with the resolved interface for each multiaddr:

```json
{
  "multiaddrs": [
    {"addr": "/ip4/127.0.0.1/tcp/60001/p2p/12D3...", "iface": "lo0", "kind": "loopback"},
    {"addr": "/ip4/192.168.88.164/tcp/60001/p2p/...", "iface": "en0", "kind": "lan"},
    {"addr": "/ip4/100.120.188.62/tcp/60001/p2p/...", "iface": "utun8", "kind": "tailscale"}
  ]
}
```

`kind: tailscale` detection via Tailscale CLI (`tailscale ip` matches), or fallback to a static `100.64.0.0/10` CGNAT range check. Operators eyeball the one labelled `tailscale` and copy/paste; no more wrong-device pins.

**Text format:** same info, but humanised:

```
/ip4/100.120.188.62/tcp/60001/p2p/12D3KooW... (tailscale, utun8) ← recommended for cross-machine
```

### 3.5 Subscribe filter event-kinds — silent zero-event capture

**Symptom:** `brv channel subscribe cc-chat --kinds message,delivery_state_change --exit-on-terminal --json` ran for ~10 minutes, captured zero events, despite an inbound remote turn landing. Either the kinds set was wrong for inbound remote-peer flows, or the listener registered after auto-delivery had already fired.

**Two fixes:**

- **(a)** Document the canonical event-kinds emitted for each turn flavour (local outbound, inbound remote, ACP-driven) in a new `docs/channel-events.md`. Today the kinds are scattered across the codebase; one table makes the operator-UX answerable.
- **(b)** Add `brv channel subscribe --all-kinds` convenience flag. For diagnostics, capture *everything*. Default stays filtered (current behaviour).

Investigation task: confirm whether `--kinds message,delivery_state_change` is wrong (the actual kind for inbound remote-peer terminal is likely `turn_state_change`, not `delivery_state_change`) — that's a one-line doc fix, not code. If it IS code (listener registers late on inbound auto-creation), file a follow-up.

### 3.6 `brv bridge connect <multiaddr>` — one-command setup

**Symptom:** Setup ceremony is 4 commands per peer (`brv bridge whoami` → share → `brv bridge pin <peer> --multiaddr ...` → `brv bridge verify <peer>`) plus a per-channel `brv channel invite <channel> @<handle> --peer ... --multiaddr ...`. That's eight commands for a two-laptop pair, six of them being copy-paste boilerplate.

**Fix:** new top-level command:

```bash
brv bridge connect /ip4/100.68.28.21/tcp/60001/p2p/12D3KooWKLAM... \
  --alias gcp \
  --verify \
  --channel cc-chat
```

What it does:

1. `bridge pin` (dial `/brv/identity/cert/v1`, persist).
2. If `--verify`, immediately promote to `user-confirmed` (assumes operator vetted the multiaddr out-of-band; that's the realistic Tailscale-shared-secret case).
3. If `--channel <id>` and the channel doesn't exist, `brv channel new <id>`.
4. If `--channel <id>` and the remote peer isn't a member yet, `brv channel invite <id> @<alias> --peer ... --multiaddr ...`.
5. Print a single confirmation block with the alias, peer-id, channelId, and "ready to mention".

Idempotent. Re-running on an already-connected peer is a no-op + a `[OK already connected]` line.

### 3.7 Permission flow across the bridge (tracking, not in this PR)

The headless adapter spawns `claude -p --dangerously-skip-permissions` because the bridge has no permission flow for cross-machine tool calls yet. Bob's CC can write/exec on Bob's machine; Alice has no veto. The protocol already has `permission_request` events for ACP agents; mapping Claude Code `tool_use` events to those is a follow-up. Filed as `bridge/permission-passthrough-v2` follow-up.

## 4. Implementation Phases

| Phase | Scope | Branch / PR | Test surface |
|---|---|---|---|
| **9.5.1** | §3.1 (respawn rebind) + §3.4 (multiaddr annotation) | one PR, ~200 LOC | unit + integration for daemon-restart re-bind |
| **9.5.2** | §2 adapter abstraction (refactor) | one PR, ~400 LOC | existing parley tests should pass unchanged |
| **9.5.3** | §2 ClaudeCodeHeadlessAdapter | one PR, ~500 LOC + tests | unit for env→adapter wiring + integration with a fake `claude` shim |
| **9.5.4** | §3.3 (channel mirror auto-create) | one PR, ~150 LOC | integration: VM-initiated channel appears on laptop after first inbound |
| **9.5.5** | §3.6 (`brv bridge connect`) | one PR, ~250 LOC | unit for command composition + e2e against a fake remote |
| **9.5.6** | §3.2(a)+(b) doc + `--verify` flag | one PR, ~80 LOC | doc + unit |
| **9.5.7** | §3.5 docs + `--all-kinds` flag | one PR, ~50 LOC | doc + smoke |

Each phase is independently shippable + reviewable. Total ~1700 LOC + docs, distributed across 7 PRs.

## 5. Testing Strategy

- **Unit:** each adapter implementation gets its own test file under `test/unit/server/infra/channel/bridge/adapters/`. Fake the subprocess for `ClaudeCodeHeadlessAdapter` (no real `claude` binary in CI).
- **Integration:** existing `parley-end-to-end.test.ts` extended to exercise the adapter registry path explicitly. New `bridge-connect.test.ts` covers §3.6.
- **Live two-machine:** repeat the 2026-05-22 internal-test script with INTERNAL_TEST.md updates that bake in the §3.1/§3.2/§3.6 fixes. Target: zero manual workaround commands. If the second internal-tester hits any of the six friction points, treat as a regression.

## 6. Codex Review — Resolutions

Round 1 review by codex on 2026-05-23 (turnId `fBag_vUyz7iAiiCqzHY88`, 145s). Verdict: direction good, but block 9.5.3 ship as originally written. All findings resolved in this revision:

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | **BLOCKER** | `claude -p --dangerously-skip-permissions` as default is a security hole | §2.5: registered only when `BRV_BRIDGE_CLAUDE_UNSAFE=1`. Default-off. §3.7 permission passthrough is the prerequisite for removing the gate. |
| 2 | HIGH | `BridgeDriverPool` is ACP-specific, does not generalize | §2.5: introduces `ProfileConcurrencyGate` (separate semaphore) for non-ACP adapters. ACP path keeps the pool. Both honour the same env. |
| 3 | HIGH | Explicit-bad-profile must not silently fall back to mock | §2.3: strict resolution — unset profile → mock-echo, set-but-unresolved → `ParleyAdapterNotFoundError` at startup OR `PARLEY_ADAPTER_NOT_FOUND` per-query. |
| 4 | HIGH | Session key `${channelId}\0${memberHandle}` collides across projects | §2.5: composite key `${projectRoot}\0${channelId}\0${senderPeerId}\0${adapterProfile}` using verified peerId, not display handle. Or colocate with channel-member meta. |
| 5 | MED | §3.3 overstated handshake — only peerId+displayName, no multiaddr | §3.3: explicit `addressability: 'bootstrap-only'` flag on auto-created members. `BRIDGE_MULTIADDR_STALE` error with operator-actionable hint when reverse-dial fails. |
| — | direct answer | `AsyncIterable` is correct — backpressure works via `dispatchResponseStream` awaiting `sendFrame` | Confirmed in §2.2. Stub `abortSignal` flagged for fix in 9.5.3. |
| — | direct answer | Registry: DI, not module singleton | Confirmed in §2.3 (`createDefaultRegistry({...})` factory takes deps). |
| — | direct answer | Refactor timing OK, but 9.5.2 must DELETE `local-agent-response-generator.ts` | §2.6: phase-1 explicitly deletes the legacy function. Scaffold PR is not done until this is collapsed. |
| — | direct answer | `warm()` needs typed availability result | §2.2: returns `AdapterWarmResult` (discriminated union). |
| — | direct answer | Adapters MUST throw `ParleyResponseError`, not emit `transcript_seal` directly | §2.2 + §2.5 failure-mode table updated. Parley-server owns seal emission. |

### Round 2 — codex sign-off (turnId `oYjfuTVo4yyc0f3PZHEXq`, 30s)

**Verdict:** signed off on both 9.5.2 and 9.5.3 design.

- **9.5.2:** sign off, provided `local-agent-response-generator.ts` is DELETED in the same PR as the scaffold (not left beside `AcpAdapter`). Currently the implementor's scaffold has the duplicate path — next pass collapses it.
- **9.5.3:** sign off on the design — unsafe headless Claude default-off, gated by `BRV_BRIDGE_CLAUDE_UNSAFE=1`, permission passthrough required before default promotion.

**Round-2 questions resolved:**

1. **`brv bridge connect` rollback:** accept partial progress + idempotent re-run. NO transactional state. Each completed step is independently valid; print per-step status and the exact next retry command on failure. §3.6 updated.
2. **Sidecar vs colocation:** sidecar first acceptable for 9.5.3, IF the §2.5 requirements (`0600`, atomic rename, mutex, stale GC, verified `senderPeerId`) are treated as hard requirements. Colocation follows in 9.5.4.
3. **Quota cap:** start at **5/peer/hour** (tighter than the originally-proposed 10), configurable via env/config. Lower blast radius for a verified-but-bad peer. §3.3 quota updated.

---

**Status:** plan validated; 9.5.2 (refactor + delete legacy), 9.5.3 (headless adapter behind unsafe-opt-in), and 9.5.4 (channel-mirror auto-create) all signed off by codex and shipped. Phases 9.5.6 (`brv bridge connect`) + 9.5.1 (daemon respawn rebind) + the smaller §3.2/§3.4/§3.5 fixes remain.

### ⚠️ Migration note — 9.5.4 trust-gate behavior change

Pre-9.5.4: `BRV_BRIDGE_AUTO_PROVISION=auto` would auto-create channel mirrors from inbound parley calls by *any* policy-accepted peer, including `auto-tofu` (first-contact). The receiver had no opportunity to vet the peer between handshake and mirror creation.

Post-9.5.4: channel-mirror auto-create requires the sender to be in `user-confirmed` or `ca-bound` pin state. `BRV_BRIDGE_AUTO_PROVISION=auto` still lets `auto-tofu` peers send turns to *existing* channels (no change there), but they cannot spawn new channelIds on the receiver without a one-time `brv bridge verify <peer>` promotion first.

**Operator impact:** the 4-command setup ceremony documented in INTERNAL_TEST.md (`brv bridge whoami → share → bridge pin → bridge verify`) is now mandatory before cross-machine channel use. Tests on the 2026-05-22 internal cut already required this; the change just makes the behaviour explicit and refuses to auto-create silently for unverified peers.

There is intentionally **no opt-out env** — codex round-6 sign-off explicitly recommended against it. Operators who want frictionless first-contact channels should run `brv bridge connect` (phase 9.5.6) which bundles pin + verify into one command.

### Round 3 — codex implementation review (turnId `K79P0sTCkPTOaaZefPoh1`, 126s)

After the 9.5.2 + 9.5.3 implementation landed (276 tests passing), codex performed a static implementation review against the signed-off plan.

**9.5.2: signed off.** Legacy `local-agent-response-generator.ts` deleted; strict registry resolution correct; ACP / refactor side matches the plan.

**9.5.3: blocked on three items** (all addressed in the 9.5.3-fix-up pass):

| # | Severity | Issue | Fix |
|---|---|---|---|
| 1 | **BLOCKER** | `dispatchResponseStream`'s `requestAbortController.abort()` only fires in `finally` after the generator unwinds. If Alice closes mid-turn, subprocess stays alive. | Abort early on heartbeat-send failure, sendFrame failure, daemon shutdown (SIGTERM/SIGINT), and any libp2p stream-close hook. The existing `finally` stays for the normal-completion path. |
| 2 | HIGH | `warm()` is implemented but never called at startup. `spawn()` has no `'error'` listener — first query risks unhandled child-process error if `claude` missing. | Daemon startup calls `warm()` on the resolved adapter; if `claude-code` returns `available: false`, daemon throws at startup. `spawn()` gets an `'error'` listener that translates ENOENT into `ADAPTER_SUBPROCESS_FAILED`. |
| 3 | HIGH | `ParleyAdapterNotFoundError` for `claude-code` profile doesn't mention `BRV_BRIDGE_CLAUDE_UNSAFE`. Operator gets vague "not found" instead of an actionable hint. | Profile-specific hint table inside the error class. For `claude-code`, append a line referencing `BRV_BRIDGE_CLAUDE_UNSAFE=1` and plan §2.5. |
| 4 | MED | Startup GC of session-store not wired. | Acceptable for 9.5.3 ship; tracked as 9.5.4 debt. Stale-session retry already mitigates the correctness case. |

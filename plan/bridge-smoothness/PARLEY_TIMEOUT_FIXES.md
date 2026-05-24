# Parley Timeout Fixes — Phase 9.5.7

**Date:** 2026-05-24
**Driving bug report:** `plan/channel-protocol/BUG_REPORT_PARLEY_TIMEOUTS_2026-05-24.md`
**Branch:** `proj/channel-protocol` (target HEAD `8219e3684`)
**Phase:** 9.5.7 — follow-up patches to the bridge-smoothness stack shipped today

## 1. Why

A live cross-machine test session on 2026-05-24 hit three distinct failure modes inside a 2-hour window dispatching long agentic tasks via the `claude-code` sdk-headless parley adapter. Two are real protocol bugs we shipped; one is a configuration foot-gun. Codex round-3 sign-off on Phase 9.5.3 ([`PLAN.md` §6 round-3](PLAN.md)) acknowledged a `BridgeTranscriptService` broadcaster gap and a heartbeat-vs-watchdog mismatch as tracked follow-ups; this slice closes both.

The driving incident: 26 minutes of completed agent work showed up as `TRANSCRIPT_TERMINAL_MISSING` on the dispatcher, making the operator believe all work was lost. (It wasn't — but the protocol couldn't prove it.) Failure #3 timed out *before any tool call ran*, blocking the bridge for long-running tasks entirely.

The investigation pass (code-research, 2026-05-24) produced exact file:line refs for every failure path. This plan turns those refs into a fix-and-ship list.

## 2. The three failures

### 2.1 Failure #1 — `PARLEY_LOCAL_AGENT_PROFILE_MISSING`

**Symptom:** `BRV_BRIDGE_PARLEY_PROFILE="claude-code" does not exist in the driver-profile registry`, ~3s after dispatch. Zero work product.

**Root cause:** name-collision in `createDefaultRegistry`. When `BRV_BRIDGE_CLAUDE_UNSAFE` is *unset* but `BRV_BRIDGE_PARLEY_PROFILE=claude-code` is set:

- `AcpAdapter` registers under `'claude-code'` ([`parley-adapter-registry.ts:139`](../../src/server/infra/channel/bridge/parley-adapter-registry.ts))
- `ClaudeCodeHeadlessAdapter` is NOT registered (env gate at line 152)
- Strict-resolve at [`brv-server.ts:1014`](../../src/server/infra/daemon/brv-server.ts) finds *something* under `'claude-code'` (the wrong adapter), so the daemon starts.
- Per-turn, `AcpAdapter.generate()` at [`acp-adapter.ts:56-59`](../../src/server/infra/channel/bridge/adapters/acp-adapter.ts) looks up `'claude-code'` in `profileStore`, gets `undefined`, throws `PARLEY_LOCAL_AGENT_PROFILE_MISSING`.

**Why this matters:** the existing systemd workaround prevents this in production, but the underlying bug is still present and confusing. The strict-resolve check (which exists exactly to fail-fast on misconfig) doesn't catch this case because the registration silently uses the wrong adapter type.

### 2.2 Failure #2 — `TRANSCRIPT_TERMINAL_MISSING: no transcript_seal frame`

**Symptom:** error after 26 minutes of successful work. All files written, all commits made — only the closing `transcript_seal` frame failed to arrive at the dispatcher.

**Root cause:** seal-emission/receive race. Investigation findings:

- Responder ALWAYS attempts to emit `transcript_seal` (success path at [`parley-server.ts:554-573`](../../src/server/infra/channel/bridge/parley-server.ts), error path at [`511-549`](../../src/server/infra/channel/bridge/parley-server.ts)).
- The 10s `heartbeat_ping` from commit `75b6c58b5` flows **responder → dialer only**. It resets the responder's per-stream Yamux inactivity. It does NOT add a watchdog on the dialer.
- The dialer's `readResponseFrames` is an unbounded `for await` ([`parley-client.ts`](../../src/server/infra/channel/bridge/parley-client.ts)) — no client-side timeout, no progress assertion.
- `verifyResponseStream` at [`parley-client.ts:201-203`](../../src/server/infra/channel/bridge/parley-client.ts) throws `TRANSCRIPT_TERMINAL_MISSING` when the frame-set ends without a seal.

**Most likely failure trajectory:** the responder's seal `sendFrame` failed silently (libp2p stream torn down from the dialer side) and/or the dialer's stream closed before the seal landed. The work was complete on disk; the protocol's "did this turn finish cleanly" assertion is brittle.

### 2.3 Failure #3 — `ACP_PROMPT_FAILED: The operation was aborted due to timeout`

**Symptom:** error after 10m46s. Zero tool calls. Zero work product.

**Root cause (partial):** the error string is libp2p's `AbortError` default message ([`@libp2p/interface/errors.ts:9`](../../node_modules/@libp2p/interface/src/errors.ts)). Wrapped as `AcpPromptFailedError` at [`orchestrator.ts:2066-2087`](../../src/server/infra/channel/orchestrator.ts).

**No 10-minute constant exists in the brv source.** `dialProtocol` at [`libp2p-host.ts:178`](../../src/server/infra/channel/bridge/libp2p-host.ts) is called without an explicit `AbortSignal`. The libp2p config at [`libp2p-host.ts:303-310`](../../src/server/infra/channel/bridge/libp2p-host.ts) is minimal — no `connectionManager` override:

```ts
this.node = await createLibp2p({
  addresses: {listen: [...this.config.listen_addrs]},
  connectionEncrypters: [noise()],
  privateKey: libp2pPrivateKey,
  services: {identify: identify()},
  streamMuxers: [yamux()],
  transports: [tcp()],
})
```

**Likely suspects** (need diagnostic confirmation):

1. **Tailscale DERP relay idle eviction.** If the connection is routed via DERP (not direct P2P), the relay may close after some idle period. The 10s heartbeat is per-Yamux-stream — relay-level idle detection may see TCP-level traffic differently.
2. **Some libp2p-internal abort wired to identify protocol expiry or similar.**
3. **A platform-level NAT timeout** that drops idle TCP connections after ~10 minutes.

Failure #3 needs a diagnostic re-test to nail down. The fix below treats it defensively: add explicit per-turn timeout + connection keepalive + clearer error reporting.

### 2.4 Subscribe missed-terminal-event bug (cross-cutting)

**Symptom:** `brv channel subscribe --turn <id> --kinds delivery_state_change --count 1 --json` sat with empty stdout >25 min while the channel store had already recorded the terminal `errored` event ~22 min earlier.

**Root cause:** lost-wakeup race. The orchestrator DOES broadcast the terminal event at [`orchestrator.ts:2075`](../../src/server/infra/channel/orchestrator.ts) (`persistAndBroadcast` → `broadcastToChannel(ChannelEvents.TURN_EVENT)`). The subscribe command connects to the daemon AFTER, registers the listener, and waits — but the terminal event already fired. There's no replay path unless `--after-seq` is explicitly passed.

### 2.5 BridgeTranscriptService doesn't broadcast (bonus)

[`bridge-transcript-service.ts:69-96`](../../src/server/infra/channel/bridge/bridge-transcript-service.ts) constructor takes no `broadcaster` field. Terminal events on the RESPONDER side persist to disk only. Anyone subscribing on the VM sees nothing for cross-bridge turns. Codex flagged this as a tracked follow-up at the end of 9.5.4.

## 3. Fix plan

### 3.1 Fix #1 — reserved built-in adapter names

**File:** [`src/server/infra/channel/bridge/parley-adapter-registry.ts`](../../src/server/infra/channel/bridge/parley-adapter-registry.ts).

**Change:** define a **module-level manifest** of reserved names that built-in adapters own (codex round-2: NOT a declarative `isBuiltInOwnedName` property on the adapter class — that doesn't help when the built-in is env-gated off, which is exactly the failure case here):

```ts
// The set of profile names owned by built-in adapters. AcpAdapter MUST
// never register under one of these, even if it's been wired via
// BRV_BRIDGE_PARLEY_PROFILE. When the matching built-in is env-gated off
// (e.g. claude-code without BRV_BRIDGE_CLAUDE_UNSAFE=1), the strict
// startup resolve should fail-fast with the hint table — NOT silently
// fall back to an AcpAdapter that will throw PARLEY_LOCAL_AGENT_PROFILE_MISSING
// at first turn.
//
// `Set` (not array) so the membership check is `.has()` not `.includes()`.
// (codex round-2: original plan declared array + used .has() — type bug.)
export const BUILTIN_PARLEY_PROFILE_NAMES: ReadonlySet<string> = new Set(['mock-echo', 'claude-code'])
```

In `createDefaultRegistry`, at the ACP-registration site (and ONLY there — must not short-circuit the function body, codex round-2 caught a dangerous `return` in the original sketch that would have skipped subsequent ClaudeCodeHeadlessAdapter registration):

```ts
// Inside createDefaultRegistry, around the existing AcpAdapter registration:
if (parleyProfile !== undefined && !BUILTIN_PARLEY_PROFILE_NAMES.has(parleyProfile)) {
  // Only register AcpAdapter when the configured profile name does NOT
  // collide with a built-in. The function continues past this block so
  // subsequent registrations (e.g. ClaudeCodeHeadlessAdapter under the
  // BRV_BRIDGE_CLAUDE_UNSAFE gate) still run.
  registry.register(new AcpAdapter({
    profile: parleyProfile,
    profileStore: args.profileStore,
    ...
  }))
} else if (parleyProfile !== undefined) {
  args.log(
    `[Daemon] Refusing AcpAdapter registration under reserved name "${parleyProfile}"; ` +
    `this name is owned by a built-in adapter. If you intended to use the built-in, ` +
    `check the relevant env var (e.g. BRV_BRIDGE_CLAUDE_UNSAFE=1 for claude-code).`,
  )
  // Do NOT `return` here — must let downstream registrations (claude-code, etc.) run.
}
// ClaudeCodeHeadlessAdapter registration block continues below, unchanged.
```

After this, the strict-resolve check at [`brv-server.ts:1014`](../../src/server/infra/daemon/brv-server.ts) correctly fails-fast: when `BRV_BRIDGE_PARLEY_PROFILE=claude-code` but `BRV_BRIDGE_CLAUDE_UNSAFE` is unset, `claude-code` resolves to undefined → `ParleyAdapterNotFoundError` with the existing `BRV_BRIDGE_CLAUDE_UNSAFE` hint table fires at daemon startup.

When both env vars ARE set (the normal working configuration), this block skips AcpAdapter registration AND ClaudeCodeHeadlessAdapter registers in the subsequent block — no collision, no shadow.

**Test additions** (`test/unit/server/infra/channel/bridge/parley-adapter-registry.test.ts`):
- When `BRV_BRIDGE_PARLEY_PROFILE=claude-code` and `BRV_BRIDGE_CLAUDE_UNSAFE` unset, AcpAdapter is NOT registered under `'claude-code'`.
- `resolve('claude-code')` returns `undefined`.
- `ParleyAdapterNotFoundError` from `brv-server` includes the `BRV_BRIDGE_CLAUDE_UNSAFE` hint.

**Estimated:** ~30 LOC + 3 tests. Self-contained.

### 3.2 Fix #2 — implicit-seal fallback + diagnostic seal-send

**Two layers, both small.**

**Layer A — degraded-completion fallback in `verifyResponseStream`** ([`src/server/infra/channel/bridge/parley-client.ts`](../../src/server/infra/channel/bridge/parley-client.ts)).

**Important terminology correction (codex round-2):** what the responder sends as `transcript_seal` is a *cryptographically signed* commitment over the response digest. The chunks themselves are NOT individually signed. So when the seal is missing, we cannot honestly "synthesize" a seal — what we can do is reconstruct the COMPLETION RESULT from the signed `stream_end` terminal frame plus the unsigned chunks, and explicitly mark the turn as **integrity-degraded** (we trust the responder said "I'm done" via the signed stream_end, but we lack the digest-binding the seal provides).

Today (line 201-203) throws `TRANSCRIPT_TERMINAL_MISSING` if no `transcript_seal` frame in the set. New behavior:

```ts
const seal = frames.find((f) => f.kind === 'transcript_seal')
if (!seal) {
  // Degraded-completion fallback. The seal is cryptographically signed over
  // the response digest; if it's missing, we DO NOT have the integrity
  // binding it would provide. But we CAN trust the signed stream_end terminal
  // frame as "responder said it's done" — and the application-layer chunks,
  // while unsigned individually, were transported under the same authenticated
  // libp2p session. So the turn is salvageable as a "completed but
  // integrity-degraded" record.
  //
  // Strict pre-conditions: (a) a signed stream_end frame whose signature
  // VERIFIES against the responder's L1/L2 pub key (codex round-2: the prose
  // said "signed"; the implementation must enforce that BEFORE falling back),
  // (b) it is the LAST non-heartbeat frame in the set (we don't accept a
  // stream_end followed by more chunks — that's malformed), (c) at least one
  // agent_message_chunk exists. Any of these missing → still throw.
  const lastNonHeartbeat = lastNonHeartbeatFrame(frames)
  const streamEnd = frames.find((f) => f.kind === 'stream_end')
  const chunks = frames.filter((f) => f.kind === 'agent_message_chunk')
  const streamEndSignatureValid = streamEnd !== undefined &&
    await verifyFrameSignature(streamEnd, args.responderPubKey)
  if (streamEnd && streamEndSignatureValid && lastNonHeartbeat?.kind === 'stream_end' && chunks.length > 0) {
    args.log(
      `[parley-client] No transcript_seal frame received, but found a signed ` +
      `stream_end as the last frame plus ${chunks.length} chunk(s). Returning ` +
      `degraded completion (sealOrigin=implicit-from-signed-terminal). ` +
      `Operator-visible: this turn is COMPLETED but lacks the cryptographic ` +
      `digest binding the seal would provide.`,
    )
    return {
      ...synthesizeCompletionFromChunks(chunks),  // NOT "synthesizeSeal"
      sealOrigin: 'implicit-from-signed-terminal',
      integrityDegraded: true,  // new field on the returned shape
    }
  }
  throw new Error('TRANSCRIPT_TERMINAL_MISSING: no transcript_seal frame')
}
```

The returned shape gets two new fields:
- `sealOrigin: 'explicit' | 'implicit-from-signed-terminal'`
- `integrityDegraded: boolean` (true only for the fallback path)

Both surface in `brv channel show <turnId> --json` so operators can audit which turns landed degraded. The human-output renderer adds a clear `⚠ integrity-degraded (no transcript_seal)` annotation on those rows.

**This is not "cryptographically sealed" by the original protocol guarantee.** We do not call it that anywhere in the code or in user-facing output. The fallback gives us a recoverable UX without lying about the protocol property.

**Layer B — diagnostic seal-send on responder** ([`src/server/infra/channel/bridge/parley-server.ts`](../../src/server/infra/channel/bridge/parley-server.ts), lines 554-573 and 511-549).

Wrap the seal `sendFrame` calls in explicit try/catch with diagnostic logging:

```ts
try {
  await sendFrame(stream, sealFrame)
} catch (err) {
  args.log(
    `[parley-server] Failed to send transcript_seal frame for turn=${turnId}: ` +
    `${err instanceof Error ? err.message : String(err)}. ` +
    `Stream likely torn down by dialer; work product is on disk (channelId=${channelId}, turnId=${turnId}).`,
  )
  // Do NOT re-throw — the work is durable on disk; the dialer's
  // implicit-seal fallback (Layer A) covers the wire-level failure.
}
```

Today the seal-send error gets swallowed inside the generic `dispatchResponseStream` error handling, making diagnosis impossible. Surfacing it as a dedicated log line + counter means we can quantify "how often is the seal lost" in subsequent live tests.

**Test additions** (extend [`test/unit/server/infra/channel/bridge/parley-server.test.ts`](../../test/unit/server/infra/channel/bridge/parley-server.test.ts) and the client tests):

- `verifyResponseStream` with a frame set containing **signed** `stream_end + chunks + no seal` returns `sealOrigin: 'implicit-from-signed-terminal'` + `integrityDegraded: true` (codex round-2: align test name with the renamed field).
- `verifyResponseStream` with `stream_end` that fails signature verification (forged or stale) → still throws (do NOT fall back on an unsigned terminal).
- `verifyResponseStream` with a frame set containing only `stream_end` (no chunks) still throws.
- `verifyResponseStream` with `chunks + stream_end + agent_message_chunk-after-stream_end` (malformed ordering) → still throws (stream_end must be the LAST non-heartbeat frame).
- Seal-send failure on responder is caught + logged + does not crash `dispatchResponseStream`.

**Estimated:** ~60 LOC + 4 tests. Touches both client and server sides of the parley protocol.

### 3.3 Fix #3 — defensive: split timeouts + AbortSignal threading + diagnostic phases

Three layers. Framed as **defensive hardening**, not a confirmed root-cause fix — the exact mechanism behind the 10:46 abort is still unconfirmed (codex round-2 verdict: ship these with a live retest required to prove which layer fires).

**Layer A — split timeouts: short dial/protocol, long idle/no-progress** ([`src/server/infra/channel/bridge/remote-member-driver.ts`](../../src/server/infra/channel/bridge/remote-member-driver.ts) and [`parley-client.ts`](../../src/server/infra/channel/bridge/parley-client.ts)).

Two separate timers, two separate concerns (codex round-2 correction: a single 60-min wall-clock cap is too aggressive; split it):

```ts
// 1. Short dial/protocol setup timeout — defends against dead peers, NAT failures.
//    Default 30s; configurable via BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS.
const dialTimeoutMs = parseEnvIntOr(env.BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS, 30_000)

// 2. Long idle/no-progress timeout — defends against silent stalled agents.
//    RESETS on every frame received from the responder (any chunk, heartbeat,
//    thought, tool_use, etc.). Default 60 min; configurable via
//    BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS. NO hard wall-clock cap by default.
const idleTimeoutMs = parseEnvIntOr(env.BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS, 60 * 60 * 1000)

const abortController = new AbortController()
let lastActivityAt = Date.now()
const idleCheckHandle = setInterval(() => {
  if (Date.now() - lastActivityAt > idleTimeoutMs) {
    abortController.abort(new Error(
      `PARLEY_TURN_IDLE_TIMEOUT: no responder activity for ${idleTimeoutMs}ms ` +
      `(last frame: kind=${lastFrameKind}, seq=${lastFrameSeq}, ${Date.now() - lastActivityAt}ms ago)`
    ))
  }
}, Math.min(idleTimeoutMs / 10, 30_000))

// Plumbed into the parley-client's per-frame reader:
//   onFrameReceived: (frame) => { lastActivityAt = Date.now(); lastFrameKind = frame.kind; lastFrameSeq = frame.seq }
```

The split lets long agentic work proceed indefinitely as long as the responder is emitting *anything* (heartbeats count) every N minutes. **No default hard wall-clock cap** — operators who want one set `BRV_BRIDGE_PARLEY_TURN_HARD_TIMEOUT_MS=NNN` explicitly.

**Layer B — phase-stamped abort errors** (codex round-2 addition).

Each phase of the dial→envelope-write→frame-read→verification pipeline records its own elapsed time + frame counts + last frame's kind/seq. When abort fires, the error message reports which phase was active, how long it had been, and what the last observed activity was. Without this, the next retest will land in the same "we have no idea which layer aborted" position as 2026-05-24's session.

```ts
class PhaseStampedAbort extends Error {
  constructor(args: {
    phase: 'dial' | 'envelope_write' | 'frame_read' | 'verify'
    elapsedMs: number
    frameCount: number
    lastFrameKind?: string
    lastFrameSeq?: number
    localTimeoutFired: boolean
    underlying?: Error
  }) {
    super(
      `PARLEY_ABORT phase=${args.phase} elapsed=${args.elapsedMs}ms ` +
      `frameCount=${args.frameCount} lastFrame=${args.lastFrameKind}#${args.lastFrameSeq} ` +
      `localTimeoutFired=${args.localTimeoutFired}` +
      (args.underlying ? ` underlying=${args.underlying.message}` : '')
    )
  }
}
```

The first retest with this in place tells us which layer aborts at ~10:46.

**Layer C — thread the AbortController's signal through the full read pipeline, not just the dial** ([`src/server/infra/channel/bridge/libp2p-host.ts:169-185`](../../src/server/infra/channel/bridge/libp2p-host.ts) + [`parley-client.ts`](../../src/server/infra/channel/bridge/parley-client.ts)).

**Codex round-2 correction:** passing `signal` to `dialProtocol()` only covers the dial/protocol negotiation phase. After the libp2p stream is established, the signal must be wired to BOTH (a) close/abort the established stream and (b) race against `readResponseFrames` so an in-flight read can actually be interrupted. Just passing the signal once at dial-time is insufficient.

```ts
public async dialAndSendAndConsume<T>(
  multiaddrStr: string,
  protocol: string,
  payload: Uint8Array,
  body: (stream: …, signal?: AbortSignal) => Promise<T>,  // body gets signal too
  signal?: AbortSignal,  // NEW
): Promise<T> {
  …
  const stream = await node.dialProtocol(ma, protocol, {signal})  // covers dial phase only

  // Wire the signal to the established stream's lifecycle so abort
  // tears down the stream, not just the dial.
  const onAbort = (): void => {
    // libp2p stream supports both abort() and close() — abort triggers
    // immediate teardown of in-flight reads/writes.
    stream.abort?.(new Error('PARLEY_ABORT_VIA_SIGNAL'))
  }
  signal?.addEventListener('abort', onAbort, {once: true})

  try {
    await stream.send(payload)
    // Pass signal into body so the frame reader can race reads against it.
    return await body(stream, signal)
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await stream.close().catch(() => {})
  }
}
```

In `parley-client.ts`, `readResponseFrames` (the `for await` loop on the libp2p stream) must race against the signal:

```ts
async function* readResponseFrames(stream, signal?: AbortSignal) {
  // Throw early if already aborted at function entry.
  if (signal?.aborted) throw new Error('PARLEY_ABORT_VIA_SIGNAL')

  // Promise that rejects when the signal aborts — used to race reads.
  const abortPromise = signal === undefined
    ? new Promise<never>(() => {})  // never resolves
    : new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('PARLEY_ABORT_VIA_SIGNAL')), {once: true})
      })

  // Race each iteration against the abort promise. The libp2p stream's
  // for-await semantics let us pull one chunk at a time; we use the
  // iterator protocol explicitly so we can race the .next() call.
  const iterator = stream[Symbol.asyncIterator]()
  while (true) {
    const result = await Promise.race([iterator.next(), abortPromise])
    if (result.done) return
    yield result.value
  }
}
```

This means when the local idle timeout fires:

1. The `AbortController.abort()` triggers the listener registered in `dialAndSendAndConsume`.
2. `stream.abort(...)` immediately tears down the libp2p stream.
3. The frame reader's `Promise.race` resolves with the abort error, unblocking the `for await`.
4. The error propagates up as `PhaseStampedAbort` with our phase-stamped message, NOT libp2p's default `AbortError: "The operation was aborted"`.

Operators can grep for `PARLEY_TURN_IDLE_TIMEOUT`, `PARLEY_ABORT`, or `PARLEY_ABORT_VIA_SIGNAL`.

**Layer D — libp2p `ping` hardening (DEFERRED behind a feature flag)** (codex round-2 correction: the original plan was technically wrong about how `@libp2p/ping` works).

The original plan claimed configuring `services.ping = ping({interval: 60_000})` would auto-keepalive. **This is incorrect.** The `@libp2p/ping` service registers a separate `/ipfs/ping/1.0.0` protocol and exposes an explicit `node.services.ping.ping(peer, options)` method. It does NOT periodically ping on its own. The `PingInit` config takes `timeout`, not `interval`.

Two options for periodic-keepalive behavior:

1. **Defer entirely.** Land Layers A+B+C first, see if the retest produces a 10-min abort or not. If not, ping hardening isn't needed.
2. **Land it correctly behind a flag.** A small `BridgePingKeepalive` helper that does:

   ```ts
   // brv-specific: schedule periodic ping calls on every established connection.
   // Gated by BRV_BRIDGE_KEEPALIVE_PING_MS (unset → disabled).
   const interval = parseEnvIntOr(env.BRV_BRIDGE_KEEPALIVE_PING_MS, undefined)
   if (interval !== undefined) {
     const node = host.getNode()
     setInterval(async () => {
       for (const conn of node.getConnections()) {
         await node.services.ping.ping(conn.remotePeer).catch(/* tolerated */)
       }
     }, interval)
   }
   ```

Codex's recommendation: **defer entirely.** Ship Layers A+B+C, retest, only add the ping hardening if data shows it's needed. Avoids landing a new dep + new code path without evidence.

**Removed from the original plan:**
- `inboundConnectionThreshold` — codex correction: this is an inbound-connection RATE LIMIT, not a keepalive. Doesn't address the timeout class.
- `maxConnections: 1000` — not needed; libp2p's default is fine.
- `ping({protocolPrefix: 'brv', interval: 60_000})` — wrong API shape.

**Test additions:**
- Unit test for `BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS` + `BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS` env parsing and default fallback.
- Integration test (mock libp2p): when the idle timeout fires, the error message is a `PhaseStampedAbort` with `phase='frame_read'` and the correct frame-count/last-frame state.
- Integration test: when the responder emits any frame, the idle timer resets.

**Estimated:** ~100 LOC + 5 tests across Layers A–C. Layer D deferred (~30 LOC + 2 tests when/if needed).

### 3.4 Fix — subscribe replay (preserving listener-first ordering)

**File:** [`src/oclif/commands/channel/subscribe.ts`](../../src/oclif/commands/channel/subscribe.ts).

**Codex round-2 correction:** the original plan said "fetch BEFORE registering listener." This is WRONG — it would trade the old lost-wakeup race for a new fetch-then-listener race (events that fire DURING the fetch round-trip get dropped). The existing `subscribe.ts` deliberately registers the listener before joining the channel room. Preserve that ordering.

**Correct fix:** when `--turn <id>` is set and `--after-seq` is not, default `--after-seq=0` to trigger the existing replay path (which already exists for `--after-seq`). The replay correctly de-duplicates via `(turnId, seq)` against live events received during the fetch window.

```ts
// At argument resolution time (BEFORE listener registration):
if (args.turn !== undefined && args.afterSeq === undefined) {
  // Default --after-seq=0 when --turn is set without an explicit cursor.
  // This triggers the existing replay path in the subscribe machinery,
  // which deduplicates against live events via (turnId, seq) and so closes
  // the lost-wakeup race without introducing a fetch-vs-listener race.
  args.afterSeq = 0
}

// Existing flow continues: register listener → join room → replay events
// with seq > afterSeq → dedupe live events against replay.
```

This is a one-line default-flip plus a small docstring update. No new code paths. No race introduced.

**Test additions:**
- Subscribe with `--turn <id>` to a turn that already errored (registered AFTER the terminal-event broadcast) → exits immediately with the terminal event in stdout (was: hung forever).
- Subscribe with `--turn <id>` to a turn still in-flight → replays past events + receives future ones, no duplicates.
- Subscribe with `--turn <id> --after-seq <N>` (explicit cursor) → unchanged behavior; default-flip does not override an explicit value.

**Estimated:** ~10 LOC + 3 tests. Self-contained in the subscribe command.

### 3.5 Defer to follow-up — BridgeTranscriptService broadcaster

Not in this PR. Tracked from 9.5.4. Estimated separately at ~50 LOC + plumbing.

**Codex round-2 caveat:** this PR's subscribe-replay fix (§3.4) closes the DIALER-side lost-wakeup race for cross-bridge turns (the laptop's orchestrator DOES broadcast). It does NOT fix the RESPONDER-side observability gap (the VM's `BridgeTranscriptService` does not broadcast at all, only writes to disk). We must NOT claim "responder-side subscribe observability is fixed" until the broadcaster wire-up lands as a separate slice. Operators on the responder VM who run `brv channel subscribe` for a cross-bridge turn will still see nothing after this PR.

## 4. Ship order (codex round-2 reorder)

Reordered to land **observability before fixes** so each retest is informative:

| Order | Item | LOC | Risk | Rationale |
|---|---|---|---|---|
| 1 | Fix #1 (reserved names) | ~30 | Low | Self-contained registry change. Removes the foot-gun. |
| 2 | Fix subscribe replay (§3.4) | ~10 | Low | **Lands first AFTER #1 so every subsequent retest is observable** — without it, the next failure-#2/#3 retest sits silent forever just like 2026-05-24. |
| 3 | Fix #2 Layer B (diagnostic seal-send) | ~30 | Low | Responder-side logging. **Lands BEFORE the implicit-seal fallback** so we can quantify how often the seal is actually being lost before we paper over it. |
| 4 | Fix #2 Layer A (degraded-completion fallback) | ~40 | Low | Additive client-side. Now have data from #3 to know we're not masking a frequent bug. |
| 5 | Fix #3 Layer A (split timeouts + idle reset) | ~50 | Medium | Touches RemoteMemberDriver hot path. |
| 6 | Fix #3 Layer B (phase-stamped abort errors) | ~25 | Low | Diagnostic; runs alongside Layer A. |
| 7 | Fix #3 Layer C (AbortSignal threading through dial chain) | ~25 | Medium | API change to libp2p-host signature. |
| 8 | Fix #3 Layer D (libp2p ping hardening) | DEFERRED | n/a | Deferred per codex round-2 — land only if the retest after steps 5-7 still shows a connection-level timeout. |

Total in scope: ~210 LOC + ~14 tests. Layer D deferred. Estimated 1 day of focused work after codex round-2 sign-off.

**Why the reorder matters.** The 2026-05-24 session lost half its diagnostic value because the operator couldn't see when terminal events fired. Shipping subscribe-replay (step 2) and phase-stamped errors (step 6) before the implicit-seal fallback means we'll have actual ground-truth data on whether failure #2 was "seal-send failed" vs "subprocess died" vs "stream torn down" — instead of guessing.

## 5. Tests + verification

- Unit suite must stay green (currently 8674 passing post-merge).
- All new tests follow TDD per CLAUDE.md.
- Live re-test required for fixes #2 and #3 — dispatch a >30 min cross-machine coding task, verify no `TRANSCRIPT_TERMINAL_MISSING` (or, if seal is lost, see the implicit-seal fallback engage with a clear log line), and verify no `AbortError` after 10 min.

## 6. Codex Round-1 Review — Resolutions

Reviewer: codex on 2026-05-24, turnId `hk-cFEWULiwipP6RHNDOs` (192s). Verdict: **ship the slice, but not as written.** Three plan-level corrections + five answers. All resolved in this revision:

| # | Codex finding | Resolution |
|---|---|---|
| 1 | Reserved-name list should be a **module-level manifest**, not adapter-instance property (declarative doesn't help when built-in is env-gated off) | §3.1: `BUILTIN_PARLEY_PROFILE_NAMES` module-level const in `parley-adapter-registry.ts` |
| 2 | Implicit-seal fallback is misleading terminology — chunks aren't individually signed, missing seal = missing digest binding. Must be marked as **integrity-degraded**, not "sealed" | §3.2: renamed to "degraded-completion fallback"; `sealOrigin: 'implicit-from-signed-terminal'`; new `integrityDegraded: true` field; explicit log + UI annotation |
| 3 | Failure #3: 60-min hard wall-clock cap is too aggressive. **Split timeouts** — short dial/protocol, long idle/no-progress (resets on activity) | §3.3 Layer A: `BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS` (30s default) + `BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS` (60min default, resets on any responder frame) |
| 4 | The `@libp2p/ping` section is **technically wrong** — it's an explicit-call protocol, not auto-periodic. `PingInit` takes `timeout`, not `interval`. `inboundConnectionThreshold` is a rate-limit, not keepalive | §3.3 Layer D: removed `inboundConnectionThreshold` + `maxConnections` overrides; documented that periodic-keepalive needs an explicit `setInterval(() => services.ping.ping(...))` helper; **deferred ping hardening entirely** behind a flag until retest data shows it's needed |
| 5 | Subscribe-replay must preserve **listener-before-replay ordering** — the original "fetch BEFORE registering listener" wording introduces a new fetch-vs-listener race | §3.4: corrected to one-line default-flip — when `--turn` is set and `--after-seq` is not, default `--after-seq=0` to trigger the existing replay path (which already dedupes against live events via `(turnId, seq)`) |

**Codex round-1 direct answers (incorporated):**

1. Reserved names: **module-level manifest**, enforced before ACP registration. ✓ §3.1
2. `sealOrigin`: **yes, expose in JSON**. Also surface a warning in human output. ✓ §3.2
3. Timeout: **60 minutes idle is fine; no hard wall-clock cap by default**. Add env override. ✓ §3.3 Layer A
4. Ping: **no conflict** with `/brv/parley/query/v1` or `/brv/identity/cert/v1`; ping is a separate protocol. But needs `protocolPrefix: 'brv'` matched on both peers + correct API shape. **Deferred entirely** per codex round-2 — land only if needed. ✓ §3.3 Layer D
5. Seal-send counter: structured logs + `sealOrigin` counts in turn records are enough for this PR; explicit counter in `brv channel doctor` is a follow-up. ✓ §3.2 Layer B

**Codex's reordered ship sequence:** observability before fixes. Subscribe-replay (step 2) and diagnostic seal-send (step 3) land BEFORE the implicit-seal fallback (step 4), so retests produce ground-truth data instead of guesses. ✓ §4

### Round-1 disagreements explicitly fixed

- §3.2: removed "synthesize seal" terminology (you can synthesize a completion *result*, not a cryptographic seal). Now uses `synthesizeCompletionFromChunks`.
- §3.3: removed `inboundConnectionThreshold` (rate-limit, not keepalive).
- §3.3: removed `ping({interval: 60_000})` (wrong API shape).
- §3.4: corrected "fetch before listener" to "default `--after-seq=0` triggers existing replay" (no new race).
- §3.5: explicit caveat that responder-side subscribe observability is NOT fixed in this PR; requires `BridgeTranscriptService` broadcaster follow-up.

### Round-2 questions — codex answered all three

1. **Diagnostic seal-send counter in `brv channel doctor`:** **follow-up, not this PR.** Structured logs + `sealOrigin` / `integrityDegraded` records in the turn store are enough operator visibility for the first cut.
2. **Degraded-completion fallback feature flag vs default-on:** **default-on.** The operator-recovery story is the whole point; the `integrityDegraded: true` marker is the guardrail.
3. **Dial timeout default:** **30s.** 10s is too brittle for Tailscale/DERP/high-latency routes.

### Round-3 sign-off + implementation notes

Codex round-3 (turnId `qmi1cOizxu9-zChVUfeql`, 27s) — **signed off for 9.5.7 implementation.** Layer D ping still deferred. Two implementation constraints to keep visible during code:

1. **§3.2 signature verification must bind the same payload as the existing `verifyResponseTerminal`.** A loose `verifyFrameSignature(streamEnd, responderPubKey)` check would under-bind the degraded fallback. The verification must cover `channel_id`, `delivery_id`, `protocol`, `request_envelope_hash`, `seq`, `turn_id`, and the terminal payload — same fields as the existing terminal verification. Implementation should reuse `verifyResponseTerminal` or share the underlying helper, not roll a new generic frame-signature check.

2. **§3.3 Layer C must preserve `signal.reason`.** When the idle timer calls `abortController.abort(new Error('PARLEY_TURN_IDLE_TIMEOUT: ...'))`, the stream-abort path and the read-race rejection must propagate that reason into `PhaseStampedAbort`, NOT replace it with a generic `PARLEY_ABORT_VIA_SIGNAL` marker. The pseudocode in §3.3 Layer C should be implemented as:

   ```ts
   const onAbort = (): void => {
     // Preserve signal.reason if the abort carried a custom error.
     const reason = signal?.reason instanceof Error
       ? signal.reason
       : new Error('PARLEY_ABORT_VIA_SIGNAL')
     stream.abort?.(reason)
   }
   signal?.addEventListener('abort', onAbort, {once: true})
   try {
     await stream.send(payload)
     return await body(stream, signal)
   } finally {
     // Remove the listener even when signal didn't fire.
     signal?.removeEventListener('abort', onAbort)
     await stream.close().catch(() => {})
   }
   ```

   And in `readResponseFrames`, the race promise rejects with `signal.reason` (when present) instead of a fresh error:

   ```ts
   const abortPromise = signal === undefined
     ? new Promise<never>(() => {})
     : new Promise<never>((_, reject) => {
         signal.addEventListener('abort', () => {
           reject(signal.reason instanceof Error ? signal.reason : new Error('PARLEY_ABORT_VIA_SIGNAL'))
         }, {once: true})
       })
   ```

### Round-2 blockers (resolved in this revision)

| # | Codex round-2 finding | Resolution |
|---|---|---|
| 1 | §3.1 `BUILTIN_PARLEY_PROFILE_NAMES` typed as array but used `.has()` — type bug | Now `ReadonlySet<string>` with `new Set([...])` |
| 2 | §3.1 `return` inside `createDefaultRegistry` would short-circuit ClaudeCodeHeadlessAdapter registration if reached during the same function call | Replaced with an if/else-if branch: ACP registration is skipped when name collides; downstream registrations continue |
| 3 | §3.2 tests referenced old `'implicit-from-stream-end'` field name | Renamed to `'implicit-from-signed-terminal'` throughout |
| 4 | §3.2 fallback sketch said "signed" in prose but didn't enforce signature verification before fallback | Added explicit `verifyFrameSignature(streamEnd, responderPubKey)` step; added a test for forged-signature rejection |
| 5 | §3.3 Layer C: signal-on-`dialProtocol` covers dial only, not the established-stream read loop | Layer C now wires the signal to BOTH `stream.abort()` AND `Promise.race` inside `readResponseFrames`. Full read-loop interruption via the iterator protocol. |

## 7. References

- [BUG_REPORT_PARLEY_TIMEOUTS_2026-05-24.md](../../../plan/channel-protocol/BUG_REPORT_PARLEY_TIMEOUTS_2026-05-24.md) — the driving report
- [PLAN.md](PLAN.md) — Phase 9.5 plan with codex review history
- [`75b6c58b5`](https://github.com/campfirein/byterover-cli/commit/75b6c58b5) — earlier heartbeat fix
- Investigation pass (code-research agent, 2026-05-24): full file:line refs for every failure path

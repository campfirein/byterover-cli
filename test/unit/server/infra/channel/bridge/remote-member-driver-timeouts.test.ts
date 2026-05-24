// Phase 9.5.7 — remote-member-driver timeout regression tests.
//
// Three issues from the Codex impl-review (turnId mV5p7ynMsk1bBMAcpDbOV):
//
// Issue 1 (REGRESSION): dial timeout must clear as soon as dial+send completes,
//   NOT after the full turn response returns. Pre-fix: a 60s turn with healthy
//   frame flow aborts at 30s with PARLEY_DIAL_TIMEOUT.
//
// Issue 2: idle timer must reset on every received frame, not track wall-clock
//   since turn start. Pre-fix: a turn with frames every 30s over 90 minutes
//   would abort because elapsed = 90min > idle threshold.
//
// Issue 3: when the idle timer fires (after some frames), the thrown error must
//   be a PhaseStampedAbort with phase='frame_read', correct frameCount,
//   lastFrameKind, lastFrameSeq. Pre-fix: it's just a plain Error.
//
// TDD: each test is written to FAIL on the current implementation, then the
// fix makes it pass.
//
// ES Modules cannot be stubbed with sinon (see CLAUDE.md §Testing Gotchas).
// RemoteMemberDriver accepts an optional `_sendParleyQuery` dep for unit testing.

import {expect} from 'chai'
import sinon from 'sinon'

import type {InstallIdentityService} from '../../../../../../src/agent/core/trust/install-identity-service.js'
import type {PeerTreeIdentityService} from '../../../../../../src/agent/core/trust/peer-tree-identity-service.js'
import type {AcpDriverPromptArgs} from '../../../../../../src/server/core/interfaces/channel/i-acp-driver.js'
import type {Libp2pHost} from '../../../../../../src/server/infra/channel/bridge/libp2p-host.js'
import type {SendParleyQueryArgs, SendParleyQueryResult} from '../../../../../../src/server/infra/channel/bridge/parley-client.js'

import {PhaseStampedAbort} from '../../../../../../src/server/infra/channel/bridge/phase-stamped-abort.js'
import {RemoteMemberDriver} from '../../../../../../src/server/infra/channel/bridge/remote-member-driver.js'

// ─── Minimal stub helpers ───────────────────────────────────────────────────

/**
 * Fake sendParleyQuery implementation. The test controls it by setting
 * `resolve`, `reject`, `onDialComplete`, and `onFrameReceived` fields.
 *
 * Usage:
 *   const fake = makeFakeSendParleyQuery()
 *   const driver = buildDriver({_sendParleyQuery: fake.fn})
 *   ... // start prompt
 *   fake.callOnDialComplete()    // simulate dial completes
 *   fake.resolveWith(successResult())  // simulate response ready
 */
function makeFakeSendParleyQuery() {
  let capturedArgs: SendParleyQueryArgs | undefined
  let outerResolve: ((r: SendParleyQueryResult) => void) | undefined
  let outerReject: ((err: Error) => void) | undefined

  const fn = (args: SendParleyQueryArgs): Promise<SendParleyQueryResult> => {
    capturedArgs = args
    return new Promise<SendParleyQueryResult>((resolve, reject) => {
      outerResolve = resolve
      outerReject = reject
    })
  }

  return {
    callOnDialComplete(): void {
      capturedArgs?.onDialComplete?.()
    },
    callOnFrameReceived(frame: {kind: string; seq: number}): void {
      capturedArgs?.onFrameReceived?.(frame)
    },
    get capturedArgs(): SendParleyQueryArgs | undefined { return capturedArgs },
    fn,
    rejectWith(err: Error): void {
      outerReject?.(err)
    },
    resolveWith(result: SendParleyQueryResult): void {
      outerResolve?.(result)
    },
    get signal(): AbortSignal | undefined {
      return capturedArgs?.signal
    },
  }
}

/**
 * A minimal fake host that satisfies the Libp2pHost type.
 * RemoteMemberDriver only calls dialAndSendAndConsume (via sendParleyQuery),
 * which we inject as a fake — so the host only needs to satisfy the TS type.
 */
const fakeHost: Libp2pHost = {} as unknown as Libp2pHost

/**
 * A minimal fake install/l2Identity that satisfies the constructor types.
 * Not called at all in these tests (sendParleyQuery is fully faked).
 */
const fakeInstall: InstallIdentityService = {} as unknown as InstallIdentityService
const fakeL2: PeerTreeIdentityService = {} as unknown as PeerTreeIdentityService

function buildDriver(opts: {
  _sendParleyQuery: (args: SendParleyQueryArgs) => Promise<SendParleyQueryResult>
}): RemoteMemberDriver {
  return new RemoteMemberDriver({
    _sendParleyQuery: opts._sendParleyQuery,
    channelId: 'ch-test',
    handle: '@bob',
    host: fakeHost,
    install: fakeInstall,
    l2Identity: fakeL2,
    multiaddr: '/ip4/127.0.0.1/tcp/9000',
    peerId: 'fake-remote-peer',
    // Minimal valid base64 Ed25519 pubkey (32 bytes)
    remoteL2PubKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  })
}

function successResult(): SendParleyQueryResult {
  return {
    content: 'hello',
    endedState: 'completed',
    frames: [],
    integrityDegraded: false,
    ok: true,
    sealOrigin: 'explicit',
  }
}

function minimalPromptArgs(): AcpDriverPromptArgs {
  return {
    prompt: [{text: 'hello', type: 'text'}],
    turnId: 'turn-1',
  } as unknown as AcpDriverPromptArgs
}

/**
 * Drain all events from a prompt generator into an array.
 */
async function drainPrompt(
  driver: RemoteMemberDriver,
): Promise<import('../../../../../../src/server/core/interfaces/channel/i-acp-driver.js').TurnEventPayload[]> {
  const events: import('../../../../../../src/server/core/interfaces/channel/i-acp-driver.js').TurnEventPayload[] = []
  for await (const event of driver.prompt(minimalPromptArgs())) {
    events.push(event)
  }

  return events
}

// ─── All three issue suites wrapped under one top-level describe ───────────

describe('RemoteMemberDriver — Phase 9.5.7 timeout regression tests', () => {
  // ── Issue 1: dial timeout clears before frame-read ────────────────────────

  describe('Issue 1: dial timeout clears before frame-read', () => {
    let clock: sinon.SinonFakeTimers

    beforeEach(() => {
      clock = sinon.useFakeTimers({toFake: ['Date', 'clearInterval', 'clearTimeout', 'setInterval', 'setTimeout']})
    })

    afterEach(() => {
      clock.restore()
    })

    it('does not abort via dial timeout when onDialComplete fires, then turn runs 31s', async () => {
      // This test verifies the regression fix: the dial timeout (30s default) must be
      // cleared as soon as onDialComplete() is called (which happens at the start of the
      // body callback in sendParleyQuery, after dial+send complete).
      //
      // Pre-fix: dialTimeoutHandle only cleared in finally after sendParleyQuery returns —
      // so any turn > 30s would abort with PARLEY_DIAL_TIMEOUT even if dial was fine.
      //
      // Post-fix: onDialComplete() clears the dial timer; the turn can run indefinitely
      // as long as the idle timer (default 60min) doesn't fire.

      const fake = makeFakeSendParleyQuery()
      const driver = buildDriver({_sendParleyQuery: fake.fn})
      await driver.start()

      const origDialEnv = process.env.BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS
      process.env.BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS = '30000'  // 30s dial timeout

      const promptPromise = drainPrompt(driver)

      // Give the generator a tick to start and call sendParleyQuery
      await Promise.resolve()
      await Promise.resolve()

      expect(fake.capturedArgs).to.not.be.undefined

      // Simulate: dial completes immediately (onDialComplete fires before 30s)
      fake.callOnDialComplete()

      // Advance 31 seconds past the dial timeout — if dial timer was NOT cleared,
      // the combinedAbortController would have fired and the sendParleyQuery
      // promise would reject.
      clock.tick(31_000)

      // Allow any timers/intervals to fire
      await Promise.resolve()
      await Promise.resolve()

      // Now resolve the parley query — should succeed because dial abort was cleared
      fake.resolveWith(successResult())

      // Should complete without throwing
      const events = await promptPromise
      expect(events).to.be.an('array')

      if (origDialEnv === undefined) {
        delete process.env.BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS
      } else {
        process.env.BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS = origDialEnv
      }
    })
  })

  // ── Issue 2: idle timer resets on each received frame ─────────────────────

  describe('Issue 2: idle timer resets on frame received', () => {
    let clock: sinon.SinonFakeTimers

    beforeEach(() => {
      clock = sinon.useFakeTimers({toFake: ['Date', 'clearInterval', 'clearTimeout', 'setInterval', 'setTimeout']})
    })

    afterEach(() => {
      clock.restore()
    })

    it('does not abort when frames arrive every 8s with a 10s idle timeout', async () => {
      // Pre-fix: the idle check uses `Date.now() - turnStartedAt` (wall-clock since start).
      // With idleTimeoutMs=10s, after 10s the interval fires and aborts regardless of frames.
      //
      // Post-fix: onFrameReceived resets lastActivityAt, so the idle check only fires
      // if no frame arrived in the last idleTimeoutMs (10s). Frames every 8s → no abort.

      const fake = makeFakeSendParleyQuery()
      const driver = buildDriver({_sendParleyQuery: fake.fn})
      await driver.start()

      const origEnv = process.env.BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS
      process.env.BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS = '10000'  // 10s idle timeout

      const promptPromise = drainPrompt(driver)

      await Promise.resolve()
      await Promise.resolve()

      expect(fake.capturedArgs).to.not.be.undefined

      // Dial completes immediately — starts idle timer
      fake.callOnDialComplete()

      // Send 5 frames at 8-second intervals (40 seconds total, frames every 8s < 10s idle)
      // Cannot await inside loop (no-await-in-loop) — tick + call frame received synchronously,
      // then yield once after the loop.
      for (let i = 1; i <= 5; i++) {
        clock.tick(8000)
        fake.callOnFrameReceived({kind: 'heartbeat_ping', seq: i})
      }

      await Promise.resolve()

      // Resolve after 40s of healthy frame flow — should not have aborted
      fake.resolveWith(successResult())

      const events = await promptPromise
      expect(events).to.be.an('array')  // no abort thrown

      if (origEnv === undefined) {
        delete process.env.BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS
      } else {
        process.env.BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS = origEnv
      }
    })

    it('aborts when no frames arrive within idle timeout after dial completes', async () => {
      // Verify the idle timeout DOES fire when truly idle (no onFrameReceived calls).

      const fake = makeFakeSendParleyQuery()
      const driver = buildDriver({_sendParleyQuery: fake.fn})
      await driver.start()

      const origEnv = process.env.BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS
      process.env.BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS = '5000'  // 5s idle timeout

      // Consume the generator (drain into void — we only care about the throw)
      const promptPromise = (async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _event of driver.prompt(minimalPromptArgs())) {
          // intentionally empty — we only care about the thrown error
        }
      })()

      await Promise.resolve()
      await Promise.resolve()

      // Dial completes — starts 5s idle timer
      fake.callOnDialComplete()

      // Wire abort signal to reject the fake promise
      fake.signal?.addEventListener('abort', () => {
        const reason = fake.signal?.reason instanceof Error
          ? fake.signal.reason
          : new Error('PARLEY_ABORT_VIA_SIGNAL')
        fake.rejectWith(reason)
      }, {once: true})

      // Advance past 5s idle timeout
      clock.tick(6000)
      await Promise.resolve()
      await Promise.resolve()

      let caught: unknown
      try {
        await promptPromise
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(Error)
      expect((caught as Error).message).to.match(/PARLEY_ABORT/)

      if (origEnv === undefined) {
        delete process.env.BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS
      } else {
        process.env.BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS = origEnv
      }
    })
  })

  // ── Issue 3: PhaseStampedAbort wired into abort paths ─────────────────────

  describe('Issue 3: PhaseStampedAbort wired into abort paths', () => {
    let clock: sinon.SinonFakeTimers

    beforeEach(() => {
      clock = sinon.useFakeTimers({toFake: ['Date', 'clearInterval', 'clearTimeout', 'setInterval', 'setTimeout']})
    })

    afterEach(() => {
      clock.restore()
    })

    it('throws PhaseStampedAbort with phase=frame_read when idle timer fires after 3 frames', async () => {
      // Pre-fix: the idle abort fires with a plain Error('PARLEY_TURN_IDLE_TIMEOUT: ...').
      // Post-fix: abort fires with PhaseStampedAbort({
      //   phase: 'frame_read',
      //   frameCount: 3,
      //   lastFrameKind: 'agent_message_chunk',
      //   lastFrameSeq: 3,
      //   localTimeoutFired: true,
      // })

      const fake = makeFakeSendParleyQuery()
      const driver = buildDriver({_sendParleyQuery: fake.fn})
      await driver.start()

      const origEnv = process.env.BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS
      process.env.BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS = '5000'  // 5s idle timeout

      const promptPromise = (async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _event of driver.prompt(minimalPromptArgs())) {
          // intentionally empty
        }
      })()

      await Promise.resolve()
      await Promise.resolve()

      // Dial completes — starts idle timer
      fake.callOnDialComplete()

      // Wire abort signal to reject the fake promise (propagates PhaseStampedAbort)
      fake.signal?.addEventListener('abort', () => {
        const reason = fake.signal?.reason instanceof Error
          ? fake.signal.reason
          : new Error('PARLEY_ABORT_VIA_SIGNAL')
        fake.rejectWith(reason)
      }, {once: true})

      // Emit 3 frames before idle timeout fires
      fake.callOnFrameReceived({kind: 'agent_message_chunk', seq: 1})
      fake.callOnFrameReceived({kind: 'heartbeat_ping', seq: 2})
      fake.callOnFrameReceived({kind: 'agent_message_chunk', seq: 3})

      // Advance past 5s idle timeout (no more frames after the 3 above)
      clock.tick(6000)
      await Promise.resolve()
      await Promise.resolve()

      let caught: unknown
      try {
        await promptPromise
      } catch (error) {
        caught = error
      }

      // MUST be PhaseStampedAbort, not a plain Error
      expect(caught).to.be.instanceOf(PhaseStampedAbort)
      const psa = caught as PhaseStampedAbort
      expect(psa.phase).to.equal('frame_read')
      expect(psa.frameCount).to.equal(3)
      expect(psa.lastFrameKind).to.equal('agent_message_chunk')
      expect(psa.lastFrameSeq).to.equal(3)
      expect(psa.localTimeoutFired).to.equal(true)

      if (origEnv === undefined) {
        delete process.env.BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS
      } else {
        process.env.BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS = origEnv
      }
    })

    it('throws PhaseStampedAbort with phase=dial when dial timer fires (no onDialComplete called)', async () => {
      // When the dial timer fires (onDialComplete never called), the error must
      // be PhaseStampedAbort with phase='dial' and frameCount=0.

      const fake = makeFakeSendParleyQuery()
      const driver = buildDriver({_sendParleyQuery: fake.fn})
      await driver.start()

      const origDialEnv = process.env.BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS
      process.env.BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS = '3000'  // 3s dial timeout

      const promptPromise = (async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _event of driver.prompt(minimalPromptArgs())) {
          // intentionally empty
        }
      })()

      await Promise.resolve()
      await Promise.resolve()

      // Wire abort signal to reject the fake promise
      fake.signal?.addEventListener('abort', () => {
        const reason = fake.signal?.reason instanceof Error
          ? fake.signal.reason
          : new Error('PARLEY_ABORT_VIA_SIGNAL')
        fake.rejectWith(reason)
      }, {once: true})

      // DON'T call onDialComplete — simulates dial hanging

      // Advance past 3s dial timeout
      clock.tick(4000)
      await Promise.resolve()
      await Promise.resolve()

      let caught: unknown
      try {
        await promptPromise
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(PhaseStampedAbort)
      const psa = caught as PhaseStampedAbort
      expect(psa.phase).to.equal('dial')
      expect(psa.frameCount).to.equal(0)
      expect(psa.localTimeoutFired).to.equal(true)

      if (origDialEnv === undefined) {
        delete process.env.BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS
      } else {
        process.env.BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS = origDialEnv
      }
    })
  })
})

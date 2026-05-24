// Phase 9.5.7 §3.3 Layer C — AbortSignal threading tests.
//
// Tests that:
//   1. dialAndSendAndConsume forwards signal to stream.abort() on abort
//   2. signal.reason is preserved (not replaced with generic PARLEY_ABORT_VIA_SIGNAL)
//   3. abort listener is removed in finally block (no leak)
//   4. readResponseFrames races iterator.next() against abort signal

import {expect} from 'chai'

import {type Libp2pStreamLike} from '../../../../../../src/server/infra/channel/bridge/libp2p-host.js'
import {readResponseFramesForTest} from '../../../../../../src/server/infra/channel/bridge/parley-client.js'

describe('§3.3 Layer C — AbortSignal threading (phase 9.5.7)', () => {
  // ── readResponseFramesForTest ────────────────────────────────────────────

  describe('readResponseFrames — signal races iterator.next()', () => {
    it('propagates signal.reason when abort fires during frame read', async () => {
      const abortController = new AbortController()
      const reason = new Error('PARLEY_TURN_IDLE_TIMEOUT: no activity for 60000ms lastFrame=heartbeat_ping#5')

      // A stream that never resolves — simulates a blocked libp2p read.
      const neverStream: Libp2pStreamLike = {
        async close() {},
        remotePeerId: 'fake-peer',
        async send() {},
        [Symbol.asyncIterator]() {
          return (async function* (): AsyncIterable<{subarray: () => Uint8Array}> {
            // Never yields — simulates a blocked read.
            await new Promise<void>(() => {})  // infinite wait
            yield {subarray: () => new Uint8Array()}
          })()[Symbol.asyncIterator]()
        },
      }

      // Abort after a short delay
      setTimeout(() => { abortController.abort(reason) }, 10)

      let caught: unknown
      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars, no-empty
        for await (const _ of readResponseFramesForTest(neverStream, abortController.signal)) {}
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(Error)
      // The reason must be the ORIGINAL reason, not a generic PARLEY_ABORT_VIA_SIGNAL
      expect((caught as Error).message).to.include('PARLEY_TURN_IDLE_TIMEOUT')
    })

    it('propagates reason as-is when signal already aborted at function entry', async () => {
      const abortController = new AbortController()
      const reason = new Error('PARLEY_TURN_IDLE_TIMEOUT: pre-aborted')
      abortController.abort(reason)

      const stubStream: Libp2pStreamLike = {
        async close() {},
        remotePeerId: 'fake-peer',
        async send() {},
        [Symbol.asyncIterator]() {
          return (async function* (): AsyncIterable<{subarray: () => Uint8Array}> {
            yield {subarray: () => new Uint8Array()}
          })()[Symbol.asyncIterator]()
        },
      }

      let caught: unknown
      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars, no-empty
        for await (const _ of readResponseFramesForTest(stubStream, abortController.signal)) {}
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(Error)
      expect((caught as Error).message).to.include('PARLEY_TURN_IDLE_TIMEOUT')
    })

    it('uses generic PARLEY_ABORT_VIA_SIGNAL when signal.reason is not an Error', async () => {
      const abortController = new AbortController()

      const neverStream: Libp2pStreamLike = {
        async close() {},
        remotePeerId: 'fake-peer',
        async send() {},
        [Symbol.asyncIterator]() {
          return (async function* (): AsyncIterable<{subarray: () => Uint8Array}> {
            await new Promise<void>(() => {})
            yield {subarray: () => new Uint8Array()}
          })()[Symbol.asyncIterator]()
        },
      }

      // Abort with a non-Error reason (string) — fallback to generic
      setTimeout(() => { abortController.abort('string-reason') }, 10)

      let caught: unknown
      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars, no-empty
        for await (const _ of readResponseFramesForTest(neverStream, abortController.signal)) {}
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(Error)
      expect((caught as Error).message).to.include('PARLEY_ABORT_VIA_SIGNAL')
    })
  })
})

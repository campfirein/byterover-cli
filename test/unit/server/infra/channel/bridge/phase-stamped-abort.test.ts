// Phase 9.5.7 §3.3 Layer B — PhaseStampedAbort tests.
//
// `PhaseStampedAbort` is an error class that carries phase, elapsed time,
// frame counts, and last frame state so log-grep on a timeout tells us
// exactly where in the dial→verify pipeline the abort fired.

import {expect} from 'chai'

import {PhaseStampedAbort} from '../../../../../../src/server/infra/channel/bridge/phase-stamped-abort.js'

describe('PhaseStampedAbort (phase 9.5.7 §3.3 Layer B)', () => {
  it('is an instance of Error', () => {
    const err = new PhaseStampedAbort({
      elapsedMs: 1000,
      frameCount: 5,
      lastFrameKind: 'agent_message_chunk',
      lastFrameSeq: 5,
      localTimeoutFired: true,
      phase: 'frame_read',
    })
    expect(err).to.be.instanceOf(Error)
  })

  it('message contains phase, elapsedMs, frameCount, and localTimeoutFired', () => {
    const err = new PhaseStampedAbort({
      elapsedMs: 12_345,
      frameCount: 7,
      lastFrameKind: 'heartbeat_ping',
      lastFrameSeq: 7,
      localTimeoutFired: true,
      phase: 'frame_read',
    })
    expect(err.message).to.include('frame_read')
    expect(err.message).to.include('12345')
    expect(err.message).to.include('frameCount=7')
    expect(err.message).to.include('localTimeoutFired=true')
  })

  it('exposes all constructor args as properties', () => {
    const err = new PhaseStampedAbort({
      elapsedMs: 500,
      frameCount: 2,
      lastFrameKind: 'stream_end',
      lastFrameSeq: 2,
      localTimeoutFired: false,
      phase: 'dial',
      underlying: new Error('PARLEY_TURN_IDLE_TIMEOUT: no activity for 500ms'),
    })
    expect(err.phase).to.equal('dial')
    expect(err.elapsedMs).to.equal(500)
    expect(err.frameCount).to.equal(2)
    expect(err.lastFrameKind).to.equal('stream_end')
    expect(err.lastFrameSeq).to.equal(2)
    expect(err.localTimeoutFired).to.equal(false)
    expect(err.underlying).to.be.instanceOf(Error)
  })

  it('message includes underlying.message when underlying is provided', () => {
    const err = new PhaseStampedAbort({
      elapsedMs: 999,
      frameCount: 0,
      localTimeoutFired: true,
      phase: 'dial',
      underlying: new Error('PARLEY_TURN_IDLE_TIMEOUT: the specific reason'),
    })
    expect(err.message).to.include('PARLEY_TURN_IDLE_TIMEOUT')
  })

  it('works without optional fields (lastFrameKind, lastFrameSeq, underlying)', () => {
    // These are optional and may be absent at the start of a dial (no frames yet).
    const err = new PhaseStampedAbort({
      elapsedMs: 100,
      frameCount: 0,
      localTimeoutFired: false,
      phase: 'dial',
    })
    expect(err.message).to.include('dial')
    expect(err.lastFrameKind).to.equal(undefined)
    expect(err.lastFrameSeq).to.equal(undefined)
    expect(err.underlying).to.equal(undefined)
  })
})

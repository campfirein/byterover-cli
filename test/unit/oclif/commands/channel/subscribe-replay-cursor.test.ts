import {expect} from 'chai'

import {resolveReplayCursor} from '../../../../../src/oclif/commands/channel/subscribe.js'

// Phase 9.5.7 §3.4 — subscribe replay cursor default-flip.
//
// When --turn is set and --after-seq is NOT explicitly provided, the cursor
// defaults to 0 so the existing replay path re-delivers already-stored events.
// This closes the lost-wakeup race when brv channel subscribe connects AFTER
// the terminal event was broadcast (BUG_REPORT_PARLEY_TIMEOUTS_2026-05-24 §2.4).

describe('resolveReplayCursor (phase 9.5.7 §3.4 — subscribe replay default-flip)', () => {
  it('returns {turn, afterSeq:0} when --turn is set and --after-seq is not', () => {
    const result = resolveReplayCursor({afterSeq: undefined, turn: 'turn-abc'})
    expect(result).to.deep.equal({afterSeq: 0, turn: 'turn-abc'})
  })

  it('returns {turn, afterSeq:N} when both --turn and --after-seq are explicitly set', () => {
    const result = resolveReplayCursor({afterSeq: 12, turn: 'turn-abc'})
    expect(result).to.deep.equal({afterSeq: 12, turn: 'turn-abc'})
  })

  it('returns {turn:undefined, afterSeq:undefined} when neither is set', () => {
    const result = resolveReplayCursor({afterSeq: undefined, turn: undefined})
    expect(result).to.deep.equal({afterSeq: undefined, turn: undefined})
  })

  it('does NOT override an explicit --after-seq=0', () => {
    // afterSeq=0 is already 0, same as the default. Explicit 0 must be
    // treated identically — replay from seq 0 either way.
    const result = resolveReplayCursor({afterSeq: 0, turn: 'turn-abc'})
    expect(result).to.deep.equal({afterSeq: 0, turn: 'turn-abc'})
  })

  it('willReplay is true when turn is set (even with defaulted afterSeq)', () => {
    const result = resolveReplayCursor({afterSeq: undefined, turn: 'turn-abc'})
    expect(result.turn !== undefined && result.afterSeq !== undefined).to.be.true
  })
})

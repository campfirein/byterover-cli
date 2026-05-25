import {expect} from 'chai'

import {HandshakeRateLimiter} from '../../../../../../src/server/infra/channel/bridge/parley-rate-limit.js'

describe('HandshakeRateLimiter', () => {
  it('initially reports no peer as blocked', () => {
    const limiter = new HandshakeRateLimiter()
    expect(limiter.isBlocked('peerA')).to.equal(false)
  })

  it('does not block after fewer than `badSigBurst` failures', () => {
    const t = 1_000_000
    const limiter = new HandshakeRateLimiter({config: {badSigBurst: 5}, now: () => t})
    for (let i = 0; i < 4; i++) {
      expect(limiter.recordFailure('peerA')).to.equal(false)
    }

    expect(limiter.isBlocked('peerA')).to.equal(false)
  })

  it('blocks once `badSigBurst` failures land within the window', () => {
    const t = 1_000_000
    const limiter = new HandshakeRateLimiter({config: {badSigBurst: 3}, now: () => t})
    expect(limiter.recordFailure('peerA')).to.equal(false)
    expect(limiter.recordFailure('peerA')).to.equal(false)
    expect(limiter.recordFailure('peerA')).to.equal(true)  // third trips the block
    expect(limiter.isBlocked('peerA')).to.equal(true)
  })

  it('resets the failure counter once the window expires', () => {
    let t = 1_000_000
    const limiter = new HandshakeRateLimiter({
      config: {badSigBurst: 3, badSigWindowMs: 1000},
      now: () => t,
    })
    limiter.recordFailure('peerA')
    limiter.recordFailure('peerA')
    t += 2000  // window elapsed
    expect(limiter.recordFailure('peerA')).to.equal(false)
    expect(limiter.isBlocked('peerA')).to.equal(false)
  })

  it('unblocks the peer once the cooldown expires', () => {
    let t = 1_000_000
    const limiter = new HandshakeRateLimiter({
      config: {badSigBurst: 2, badSigCooldownMs: 500},
      now: () => t,
    })
    limiter.recordFailure('peerA')
    limiter.recordFailure('peerA')
    expect(limiter.isBlocked('peerA')).to.equal(true)
    t += 600
    expect(limiter.isBlocked('peerA')).to.equal(false)
  })

  it('invokes onBlock callback when a peer is blocked', () => {
    const blocked: Array<{cooldownMs: number; peer: string}> = []
    const limiter = new HandshakeRateLimiter({
      config: {badSigBurst: 2, badSigCooldownMs: 777},
      onBlock: (peer, cooldownMs) => blocked.push({cooldownMs, peer}),
    })
    limiter.recordFailure('peerA')
    limiter.recordFailure('peerA')
    expect(blocked).to.deep.equal([{cooldownMs: 777, peer: 'peerA'}])
  })

  it('isolates state per peer (different peer is unaffected)', () => {
    const limiter = new HandshakeRateLimiter({config: {badSigBurst: 2}})
    limiter.recordFailure('peerA')
    limiter.recordFailure('peerA')
    expect(limiter.isBlocked('peerA')).to.equal(true)
    expect(limiter.isBlocked('peerB')).to.equal(false)
  })

  it('clear() drops all blocks + counters', () => {
    const limiter = new HandshakeRateLimiter({config: {badSigBurst: 2}})
    limiter.recordFailure('peerA')
    limiter.recordFailure('peerA')
    limiter.clear()
    expect(limiter.isBlocked('peerA')).to.equal(false)
  })
})

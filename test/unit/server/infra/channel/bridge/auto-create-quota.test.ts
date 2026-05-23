import {expect} from 'chai'

import {createAutoCreateQuota} from '../../../../../../src/server/infra/channel/bridge/auto-create-quota.js'

// Phase 9.5.4 — tests for the sliding-window auto-create quota enforcer.

describe('createAutoCreateQuota', () => {
  let logs: string[]
  let log: (msg: string) => void

  beforeEach(() => {
    logs = []
    log = (msg) => { logs.push(msg) }
  })

  it('tryConsume returns true when under cap', () => {
    const quota = createAutoCreateQuota({log, maxPerHour: 5})
    const now = new Date('2026-05-22T10:00:00.000Z')
    const result = quota.tryConsume({now, peerId: 'peer-A'})
    expect(result).to.equal(true)
  })

  it('tryConsume returns false when at cap', () => {
    const quota = createAutoCreateQuota({log, maxPerHour: 3})
    const base = new Date('2026-05-22T10:00:00.000Z')
    const peer = 'peer-B'
    // Consume 3 slots (at cap)
    expect(quota.tryConsume({now: new Date(base.getTime()), peerId: peer})).to.equal(true)
    expect(quota.tryConsume({now: new Date(base.getTime() + 1000), peerId: peer})).to.equal(true)
    expect(quota.tryConsume({now: new Date(base.getTime() + 2000), peerId: peer})).to.equal(true)
    // 4th should be rejected
    const result = quota.tryConsume({now: new Date(base.getTime() + 3000), peerId: peer})
    expect(result).to.equal(false)
  })

  it('sliding window expiry: old entries are pruned after 1 hour', () => {
    const quota = createAutoCreateQuota({log, maxPerHour: 2})
    const t0 = new Date('2026-05-22T09:00:00.000Z')
    const peer = 'peer-C'
    // Use 2 slots at T=0
    quota.tryConsume({now: t0, peerId: peer})
    quota.tryConsume({now: new Date(t0.getTime() + 1000), peerId: peer})
    // At T=0+epsilon, both slots are used → at cap
    expect(
      quota.tryConsume({now: new Date(t0.getTime() + 2000), peerId: peer}),
    ).to.equal(false)
    // Advance 1 hour + 1ms — both earlier entries fall outside the window
    const t1h = new Date(t0.getTime() + 60 * 60 * 1000 + 1)
    expect(quota.tryConsume({now: t1h, peerId: peer})).to.equal(true)
  })

  it('BRV_BRIDGE_AUTO_CREATE_QUOTA env var overrides the default cap', () => {
    const prev = process.env.BRV_BRIDGE_AUTO_CREATE_QUOTA
    process.env.BRV_BRIDGE_AUTO_CREATE_QUOTA = '2'
    try {
      const quota = createAutoCreateQuota({log})
      const t = new Date('2026-05-22T10:00:00.000Z')
      const peer = 'peer-D'
      expect(quota.tryConsume({now: t, peerId: peer})).to.equal(true)
      expect(quota.tryConsume({now: new Date(t.getTime() + 1000), peerId: peer})).to.equal(true)
      // 3rd — over the env-var cap of 2
      expect(quota.tryConsume({now: new Date(t.getTime() + 2000), peerId: peer})).to.equal(false)
    } finally {
      if (prev === undefined) {
        delete process.env.BRV_BRIDGE_AUTO_CREATE_QUOTA
      } else {
        process.env.BRV_BRIDGE_AUTO_CREATE_QUOTA = prev
      }
    }
  })

  it('reset clears a peer counter', () => {
    const quota = createAutoCreateQuota({log, maxPerHour: 2})
    const t = new Date('2026-05-22T10:00:00.000Z')
    const peer = 'peer-E'
    quota.tryConsume({now: t, peerId: peer})
    quota.tryConsume({now: new Date(t.getTime() + 1000), peerId: peer})
    // At cap
    expect(quota.tryConsume({now: new Date(t.getTime() + 2000), peerId: peer})).to.equal(false)
    // Operator uninvite → reset
    quota.reset(peer)
    // Should succeed again
    expect(quota.tryConsume({now: new Date(t.getTime() + 3000), peerId: peer})).to.equal(true)
  })

  it('different peerIds have independent counters', () => {
    const quota = createAutoCreateQuota({log, maxPerHour: 1})
    const t = new Date('2026-05-22T10:00:00.000Z')
    // peer-F reaches cap
    expect(quota.tryConsume({now: t, peerId: 'peer-F'})).to.equal(true)
    expect(quota.tryConsume({now: new Date(t.getTime() + 1000), peerId: 'peer-F'})).to.equal(false)
    // peer-G is unaffected
    expect(quota.tryConsume({now: t, peerId: 'peer-G'})).to.equal(true)
  })

  it('logs the RATE_LIMITED message when at cap', () => {
    const quota = createAutoCreateQuota({log, maxPerHour: 1})
    const t = new Date('2026-05-22T10:00:00.000Z')
    quota.tryConsume({now: t, peerId: 'peer-H'})
    quota.tryConsume({now: new Date(t.getTime() + 100), peerId: 'peer-H'})
    expect(logs).to.have.length(1)
    expect(logs[0]).to.include('RATE_LIMITED')
    expect(logs[0]).to.include('peer-H')
  })
})

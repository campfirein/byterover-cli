import {expect} from 'chai'

import {NonceLru} from '../../../../../../src/server/infra/channel/bridge/parley-nonce-lru.js'

describe('NonceLru', () => {
  it('reports unseen nonces as not present', () => {
    const lru = new NonceLru()
    expect(lru.has('12D3KooWA', 'aaa')).to.equal(false)
  })

  it('reports an inserted nonce as present', () => {
    const lru = new NonceLru()
    lru.insert('12D3KooWA', 'aaa')
    expect(lru.has('12D3KooWA', 'aaa')).to.equal(true)
  })

  it('isolates nonces per sender (same nonce from different peers is allowed)', () => {
    const lru = new NonceLru()
    lru.insert('12D3KooWA', 'aaa')
    expect(lru.has('12D3KooWB', 'aaa')).to.equal(false)
  })

  it('evicts the oldest entry per sender once the cap is reached', () => {
    const lru = new NonceLru({perSenderCapacity: 3})
    lru.insert('12D3KooWA', 'n1')
    lru.insert('12D3KooWA', 'n2')
    lru.insert('12D3KooWA', 'n3')
    lru.insert('12D3KooWA', 'n4')  // evicts n1
    expect(lru.has('12D3KooWA', 'n1')).to.equal(false)
    expect(lru.has('12D3KooWA', 'n2')).to.equal(true)
    expect(lru.has('12D3KooWA', 'n3')).to.equal(true)
    expect(lru.has('12D3KooWA', 'n4')).to.equal(true)
  })

  it('survives interleaved inserts from multiple senders without cross-eviction', () => {
    const lru = new NonceLru({perSenderCapacity: 2})
    lru.insert('A', 'a1')
    lru.insert('B', 'b1')
    lru.insert('A', 'a2')
    lru.insert('B', 'b2')
    lru.insert('A', 'a3')  // evicts a1; B is untouched
    expect(lru.has('A', 'a1')).to.equal(false)
    expect(lru.has('A', 'a2')).to.equal(true)
    expect(lru.has('A', 'a3')).to.equal(true)
    expect(lru.has('B', 'b1')).to.equal(true)
    expect(lru.has('B', 'b2')).to.equal(true)
  })

  it('clear() drops all state', () => {
    const lru = new NonceLru()
    lru.insert('A', 'a1')
    lru.clear()
    expect(lru.has('A', 'a1')).to.equal(false)
  })
})

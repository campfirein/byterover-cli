import {expect} from 'chai'

import {TurnSequenceAllocator} from '../../../../../src/server/infra/channel/turn-sequence-allocator.js'

describe('TurnSequenceAllocator', () => {
  it('allocates gap-free monotonic sequences from 0 per turn', () => {
    const alloc = new TurnSequenceAllocator()
    const args = {channelId: 'c1', turnId: 't1'}
    expect(alloc.next(args)).to.equal(0)
    expect(alloc.next(args)).to.equal(1)
    expect(alloc.next(args)).to.equal(2)
  })

  it('keeps sequences independent across turns', () => {
    const alloc = new TurnSequenceAllocator()
    expect(alloc.next({channelId: 'c1', turnId: 't1'})).to.equal(0)
    expect(alloc.next({channelId: 'c1', turnId: 't2'})).to.equal(0)
    expect(alloc.next({channelId: 'c1', turnId: 't1'})).to.equal(1)
  })

  it('restarts at 0 after reset', () => {
    const alloc = new TurnSequenceAllocator()
    const args = {channelId: 'c1', turnId: 't1'}
    alloc.next(args)
    alloc.next(args)
    alloc.reset(args)
    expect(alloc.next(args)).to.equal(0)
  })
})

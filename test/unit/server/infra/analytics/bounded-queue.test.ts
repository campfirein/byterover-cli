/* eslint-disable camelcase */
import {expect} from 'chai'

import type {StoredAnalyticsRecord} from '../../../../../src/shared/analytics/stored-record.js'

import {BoundedQueue} from '../../../../../src/server/infra/analytics/bounded-queue.js'

let eventCounter = 0
function makeEvent(name: string): StoredAnalyticsRecord {
  eventCounter += 1
  return {
    attempts: 0,
    id: `id-${eventCounter}`,
    identity: {device_id: '550e8400-e29b-41d4-a716-446655440000'},
    name,
    properties: {},
    status: 'pending',
    timestamp: 0,
  }
}

function pushAll(queue: BoundedQueue, events: StoredAnalyticsRecord[]): void {
  for (const event of events) {
    queue.push(event)
  }
}

describe('BoundedQueue', () => {
  describe('constructor validation', () => {
    it('should throw when maxSize is negative', () => {
      expect(() => new BoundedQueue(-1)).to.throw(/non-negative/)
    })

    it('should throw when maxSize is NaN', () => {
      expect(() => new BoundedQueue(Number.NaN)).to.throw(/non-negative/)
    })

    it('should throw when maxSize is Infinity', () => {
      expect(() => new BoundedQueue(Number.POSITIVE_INFINITY)).to.throw(/non-negative/)
    })

    it('should throw when maxSize is fractional', () => {
      expect(() => new BoundedQueue(1.5)).to.throw(/non-negative/)
    })

    it('should accept maxSize === 0 (degenerate but valid)', () => {
      expect(() => new BoundedQueue(0)).to.not.throw()
    })
  })

  describe('basic FIFO behavior (ticket scenario 1)', () => {
    it('should return pushed events in FIFO order on drain', () => {
      const queue = new BoundedQueue(10)
      const eventA = makeEvent('a')
      const eventB = makeEvent('b')
      const eventC = makeEvent('c')

      pushAll(queue, [eventA, eventB, eventC])

      const drained = queue.drain()

      expect(drained).to.deep.equal([eventA, eventB, eventC])
    })
  })

  describe('empty queue (ticket scenario 2)', () => {
    it('should return [] on drain when empty', () => {
      const queue = new BoundedQueue(10)

      expect(queue.drain()).to.deep.equal([])
    })

    it('should return 0 from droppedCount() when empty', () => {
      const queue = new BoundedQueue(10)

      expect(queue.droppedCount()).to.equal(0)
    })

    it('should return 0 from size() when empty', () => {
      const queue = new BoundedQueue(10)

      expect(queue.size()).to.equal(0)
    })
  })

  describe('drop-oldest semantics (ticket scenario 3)', () => {
    it('should drop the oldest event when pushing beyond maxSize', () => {
      const queue = new BoundedQueue(3)
      const events = [makeEvent('a'), makeEvent('b'), makeEvent('c'), makeEvent('d')]

      for (const event of events) {
        queue.push(event)
      }

      const drained = queue.drain()

      expect(drained).to.have.lengthOf(3)
      expect(drained[0].name).to.equal('b')
      expect(drained[1].name).to.equal('c')
      expect(drained[2].name).to.equal('d')
      expect(queue.droppedCount()).to.equal(1)
    })

    it('should track multiple drops in FIFO drop order', () => {
      const queue = new BoundedQueue(2)

      pushAll(queue, ['a', 'b', 'c', 'd', 'e'].map((n) => makeEvent(n)))

      const drained = queue.drain()

      expect(drained.map((event) => event.name)).to.deep.equal(['d', 'e'])
      expect(queue.droppedCount()).to.equal(3)
    })
  })

  describe('cumulative droppedCount (ticket scenario 4)', () => {
    it('should not reset droppedCount across drains', () => {
      const queue = new BoundedQueue(2)

      pushAll(queue, ['a', 'b', 'c'].map((n) => makeEvent(n)))
      expect(queue.droppedCount()).to.equal(1)

      queue.drain()
      expect(queue.droppedCount(), 'drain must NOT reset droppedCount').to.equal(1)

      pushAll(queue, ['d', 'e', 'f'].map((n) => makeEvent(n)))
      expect(queue.droppedCount()).to.equal(2)

      queue.drain()
      expect(queue.droppedCount()).to.equal(2)
    })
  })

  describe('size() (ticket scenario 5)', () => {
    it('should reflect current queue length', () => {
      const queue = new BoundedQueue(10)

      expect(queue.size()).to.equal(0)
      queue.push(makeEvent('a'))
      expect(queue.size()).to.equal(1)
      queue.push(makeEvent('b'))
      expect(queue.size()).to.equal(2)
    })

    it('should return zero after drain', () => {
      const queue = new BoundedQueue(10)
      pushAll(queue, [makeEvent('a'), makeEvent('b')])

      queue.drain()

      expect(queue.size()).to.equal(0)
    })

    it('should never exceed maxSize after pushes', () => {
      const queue = new BoundedQueue(3)

      for (let i = 0; i < 10; i++) {
        queue.push(makeEvent(`event_${i}`))
      }

      expect(queue.size()).to.equal(3)
    })
  })

  describe('default maxSize (ticket scenario 6)', () => {
    it('should default to 1000 and drop 1 when 1001 events are pushed', () => {
      const queue = new BoundedQueue()

      for (let i = 0; i < 1001; i++) {
        queue.push(makeEvent(`event_${i}`))
      }

      expect(queue.size()).to.equal(1000)
      expect(queue.droppedCount()).to.equal(1)
    })
  })

  describe('drain ownership transfer', () => {
    it('should return a fresh empty queue after drain (caller owns drained events)', () => {
      const queue = new BoundedQueue(10)
      pushAll(queue, [makeEvent('a'), makeEvent('b')])

      const firstDrain = queue.drain()
      queue.push(makeEvent('c'))
      const secondDrain = queue.drain()

      expect(firstDrain.map((event) => event.name)).to.deep.equal(['a', 'b'])
      expect(secondDrain.map((event) => event.name)).to.deep.equal(['c'])
    })
  })
})

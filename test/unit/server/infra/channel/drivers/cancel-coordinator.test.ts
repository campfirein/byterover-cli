import {expect} from 'chai'
import {createSandbox, type SinonSandbox} from 'sinon'

import type {IAcpDriver} from '../../../../../../src/server/core/interfaces/channel/i-acp-driver.js'
import type {TurnEvent} from '../../../../../../src/shared/types/channel.js'

import {CancelCoordinator} from '../../../../../../src/server/infra/channel/drivers/cancel-coordinator.js'
import {MockAcpDriver} from '../../../../../../src/server/infra/channel/drivers/mock-driver.js'
import {PermissionBroker} from '../../../../../../src/server/infra/channel/drivers/permission-broker.js'

// Slice 2.4 — §7.2 cancel ordering. The coordinator emits events in this
// exact order via the orchestrator's seq allocator + event writer:
//   1. permission_decision { outcome: 'cancelled' } for every pending permission
//   2. delivery_state_change { to: 'cancelled' } for every non-terminal delivery
//      (preceded by driver.cancel(turnId))
//   3. turn_state_change { to: 'cancelled' } (full-turn only; per-delivery cancel
//      finalises the turn via the normal path)

describe('CancelCoordinator', () => {
  let sandbox: SinonSandbox

  beforeEach(() => {
    sandbox = createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  type Recorded = TurnEvent
  const makeHarness = () => {
    const broker = new PermissionBroker()
    const pool = new Map<string, IAcpDriver>()
    const writtenEvents: Recorded[] = []
    let nextSeq = 5
    const allocator = {
      next() {
        const value = nextSeq
        nextSeq += 1
        return value
      },
    }
    const writeEvent = async (event: TurnEvent): Promise<void> => {
      writtenEvents.push(event)
    }

    return {
      allocator,
      broker,
      pool: {
        acquire(args: {channelId: string; memberHandle: string}): IAcpDriver | undefined {
          return pool.get(`${args.channelId}\0${args.memberHandle}`)
        },
        register(channelId: string, driver: IAcpDriver) {
          pool.set(`${channelId}\0${driver.handle}`, driver)
        },
      },
      writeEvent,
      writtenEvents,
    }
  }

  it('cancelTurn emits permission_decision → delivery_state_change → turn_state_change in order', async () => {
    const h = makeHarness()
    const driver = new MockAcpDriver({events: [], handle: '@mock'})
    const cancelSpy = sandbox.stub(driver, 'cancel').resolves()
    sandbox.stub(driver, 'respondToPermission').resolves()
    h.pool.register('c1', driver)
    h.broker.track({channelId: 'c1', deliveryId: 'd1', driver, permissionRequestId: 'p1', turnId: 't1'})

    const coordinator = new CancelCoordinator({
      broker: h.broker,
      pool: h.pool as never,
      seqAllocator: h.allocator as never,
      writeEvent: h.writeEvent,
    })

    await coordinator.cancelTurn({
      channelId: 'c1',
      inFlightDeliveries: [{deliveryId: 'd1', memberHandle: '@mock', state: 'awaiting_permission'}],
      projectRoot: '/proj',
      turnId: 't1',
      turnState: 'dispatched',
    })

    const kinds = h.writtenEvents.map((e) => e.kind)
    expect(kinds).to.deep.equal(['permission_decision', 'delivery_state_change', 'turn_state_change'])

    const permEvent = h.writtenEvents[0]
    if (permEvent.kind !== 'permission_decision') throw new Error('unreachable')
    expect(permEvent.outcome).to.deep.equal({outcome: 'cancelled'})

    const deliveryEvent = h.writtenEvents[1]
    if (deliveryEvent.kind !== 'delivery_state_change') throw new Error('unreachable')
    expect(deliveryEvent.to).to.equal('cancelled')

    const turnEvent = h.writtenEvents[2]
    if (turnEvent.kind !== 'turn_state_change') throw new Error('unreachable')
    expect(turnEvent.to).to.equal('cancelled')

    // ACP session/cancel was sent.
    expect(cancelSpy.calledOnce).to.equal(true)
    expect(cancelSpy.firstCall.args[0]).to.equal('t1')
  })

  it('cancelDelivery emits permission_decision + delivery_state_change but NOT turn_state_change', async () => {
    const h = makeHarness()
    const driver = new MockAcpDriver({events: [], handle: '@mock'})
    sandbox.stub(driver, 'cancel').resolves()
    sandbox.stub(driver, 'respondToPermission').resolves()
    h.pool.register('c1', driver)
    h.broker.track({channelId: 'c1', deliveryId: 'd1', driver, permissionRequestId: 'p1', turnId: 't1'})

    const coordinator = new CancelCoordinator({
      broker: h.broker,
      pool: h.pool as never,
      seqAllocator: h.allocator as never,
      writeEvent: h.writeEvent,
    })

    await coordinator.cancelDelivery({
      channelId: 'c1',
      delivery: {deliveryId: 'd1', memberHandle: '@mock', state: 'awaiting_permission'},
      projectRoot: '/proj',
      turnId: 't1',
    })

    const kinds = h.writtenEvents.map((e) => e.kind)
    expect(kinds).to.deep.equal(['permission_decision', 'delivery_state_change'])
  })

  it('cancelTurn assigns strictly monotonic seq values from the allocator', async () => {
    const h = makeHarness()
    const driver = new MockAcpDriver({events: [], handle: '@mock'})
    sandbox.stub(driver, 'cancel').resolves()
    sandbox.stub(driver, 'respondToPermission').resolves()
    h.pool.register('c1', driver)
    h.broker.track({channelId: 'c1', deliveryId: 'd1', driver, permissionRequestId: 'p1', turnId: 't1'})

    const coordinator = new CancelCoordinator({
      broker: h.broker,
      pool: h.pool as never,
      seqAllocator: h.allocator as never,
      writeEvent: h.writeEvent,
    })

    await coordinator.cancelTurn({
      channelId: 'c1',
      inFlightDeliveries: [{deliveryId: 'd1', memberHandle: '@mock', state: 'awaiting_permission'}],
      projectRoot: '/proj',
      turnId: 't1',
      turnState: 'dispatched',
    })

    for (let i = 1; i < h.writtenEvents.length; i += 1) {
      expect(h.writtenEvents[i].seq).to.be.greaterThan(h.writtenEvents[i - 1].seq)
    }
  })
})

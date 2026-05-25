import {expect} from 'chai'
import {createSandbox, type SinonSandbox} from 'sinon'

import {
  ChannelPermissionAlreadyResolvedError,
  ChannelPermissionNotFoundError,
} from '../../../../../../src/server/core/domain/channel/errors.js'
import {MockAcpDriver} from '../../../../../../src/server/infra/channel/drivers/mock-driver.js'
import {PermissionBroker} from '../../../../../../src/server/infra/channel/drivers/permission-broker.js'

// Slice 2.4 — bridges ACP-side `session/request_permission` to the
// channel surface. The broker only tracks pending permissions and routes
// the ACP response; emission of delivery_state_change + permission_decision
// TurnEvents is the orchestrator's responsibility (the broker returns the
// metadata the orchestrator needs).

describe('PermissionBroker', () => {
  let sandbox: SinonSandbox

  beforeEach(() => {
    sandbox = createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('resolve calls driver.respondToPermission with the outcome and returns metadata', async () => {
    const driver = new MockAcpDriver({events: [], handle: '@mock'})
    const respond = sandbox.stub(driver, 'respondToPermission').resolves()
    const broker = new PermissionBroker()
    broker.track({channelId: 'c1', deliveryId: 'd1', driver, permissionRequestId: 'p1', turnId: 't1'})

    const result = await broker.resolve({
      channelId: 'c1',
      outcome: {optionId: 'opt-allow', outcome: 'selected'},
      permissionRequestId: 'p1',
      turnId: 't1',
    })

    expect(result.deliveryId).to.equal('d1')
    expect(result.isCancellation).to.equal(false)
    expect(respond.calledOnce).to.equal(true)
    expect(respond.firstCall.args[0]).to.equal('p1')
    expect(respond.firstCall.args[1]).to.deep.equal({outcome: {optionId: 'opt-allow', outcome: 'selected'}})
  })

  it('resolve marks the outcome as isCancellation: true for a `cancelled` outcome', async () => {
    const driver = new MockAcpDriver({events: [], handle: '@mock'})
    sandbox.stub(driver, 'respondToPermission').resolves()
    const broker = new PermissionBroker()
    broker.track({channelId: 'c1', deliveryId: 'd1', driver, permissionRequestId: 'p1', turnId: 't1'})

    const result = await broker.resolve({
      channelId: 'c1',
      outcome: {outcome: 'cancelled'},
      permissionRequestId: 'p1',
      turnId: 't1',
    })
    expect(result.isCancellation).to.equal(true)
  })

  it('resolve throws CHANNEL_PERMISSION_NOT_FOUND for an unknown id', async () => {
    const broker = new PermissionBroker()
    try {
      await broker.resolve({
        channelId: 'c1',
        outcome: {outcome: 'cancelled'},
        permissionRequestId: 'p-ghost',
        turnId: 't1',
      })
      expect.fail('expected ChannelPermissionNotFoundError')
    } catch (error) {
      expect(error).to.be.instanceOf(ChannelPermissionNotFoundError)
    }
  })

  it('resolve throws CHANNEL_PERMISSION_ALREADY_RESOLVED when called twice', async () => {
    const driver = new MockAcpDriver({events: [], handle: '@mock'})
    sandbox.stub(driver, 'respondToPermission').resolves()
    const broker = new PermissionBroker()
    broker.track({channelId: 'c1', deliveryId: 'd1', driver, permissionRequestId: 'p1', turnId: 't1'})

    await broker.resolve({
      channelId: 'c1',
      outcome: {outcome: 'cancelled'},
      permissionRequestId: 'p1',
      turnId: 't1',
    })

    try {
      await broker.resolve({
        channelId: 'c1',
        outcome: {outcome: 'cancelled'},
        permissionRequestId: 'p1',
        turnId: 't1',
      })
      expect.fail('expected ChannelPermissionAlreadyResolvedError')
    } catch (error) {
      expect(error).to.be.instanceOf(ChannelPermissionAlreadyResolvedError)
    }
  })

  it('drainTurn resolves every pending permission in the turn with a cancellation outcome', async () => {
    const driver = new MockAcpDriver({events: [], handle: '@mock'})
    const respond = sandbox.stub(driver, 'respondToPermission').resolves()
    const broker = new PermissionBroker()
    broker.track({channelId: 'c1', deliveryId: 'd1', driver, permissionRequestId: 'p1', turnId: 't1'})
    broker.track({channelId: 'c1', deliveryId: 'd1', driver, permissionRequestId: 'p2', turnId: 't1'})
    broker.track({channelId: 'c1', deliveryId: 'd2', driver, permissionRequestId: 'p3', turnId: 't2'})

    const drained = await broker.drainTurn({channelId: 'c1', turnId: 't1'})
    expect(drained.map((d) => d.permissionRequestId).sort()).to.deep.equal(['p1', 'p2'])
    expect(respond.callCount).to.equal(2)
    for (const call of respond.getCalls()) {
      expect(call.args[1]).to.deep.equal({outcome: {outcome: 'cancelled'}})
    }
  })

  it('drainDelivery resolves only the named delivery, leaves other-delivery pendings alone', async () => {
    const driver = new MockAcpDriver({events: [], handle: '@mock'})
    sandbox.stub(driver, 'respondToPermission').resolves()
    const broker = new PermissionBroker()
    broker.track({channelId: 'c1', deliveryId: 'd1', driver, permissionRequestId: 'p1', turnId: 't1'})
    broker.track({channelId: 'c1', deliveryId: 'd2', driver, permissionRequestId: 'p2', turnId: 't1'})

    const drained = await broker.drainDelivery({channelId: 'c1', deliveryId: 'd1', turnId: 't1'})
    expect(drained).to.have.lengthOf(1)
    expect(drained[0].permissionRequestId).to.equal('p1')
    // p2 still pending — drainTurn would still find it.
    const rest = await broker.drainTurn({channelId: 'c1', turnId: 't1'})
    expect(rest.map((d) => d.permissionRequestId)).to.deep.equal(['p2'])
  })
})

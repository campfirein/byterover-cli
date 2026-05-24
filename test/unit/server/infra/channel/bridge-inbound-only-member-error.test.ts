
import {expect} from 'chai'

import {BridgeInboundOnlyMemberError} from '../../../../../src/server/core/domain/channel/errors.js'

/**
 * Phase 9.5.9 Issue 2 — BridgeInboundOnlyMemberError must carry the
 * BRIDGE_INBOUND_ONLY_MEMBER code at the TOP LEVEL of the error,
 * not buried in `.details.code` inside a ChannelInvalidRequestError.
 *
 * These tests FAIL before the fix is applied (the class does not exist yet).
 */
describe('BridgeInboundOnlyMemberError (Issue 2 fix)', () => {
  it('has .code === "BRIDGE_INBOUND_ONLY_MEMBER" at the top level', () => {
    const err = new BridgeInboundOnlyMemberError({
      channelId: 'ch-1',
      memberHandle: '@remote',
      recoveryHint: 'brv bridge connect <multiaddr>',
    })
    expect(err.code).to.equal('BRIDGE_INBOUND_ONLY_MEMBER')
  })

  it('is an instance of Error', () => {
    const err = new BridgeInboundOnlyMemberError({
      channelId: 'ch-1',
      memberHandle: '@remote',
      recoveryHint: 'brv bridge connect <multiaddr>',
    })
    expect(err).to.be.instanceOf(Error)
  })

  it('carries memberHandle, channelId, recoveryHint in .details', () => {
    const err = new BridgeInboundOnlyMemberError({
      channelId: 'ch-abc',
      memberHandle: '@alice',
      recoveryHint: 'run brv bridge connect',
    })
    // .details is typed as unknown on the parent ChannelError; cast here.
    const details = err.details as {channelId: string; memberHandle: string; recoveryHint: string}
    expect(details.memberHandle).to.equal('@alice')
    expect(details.channelId).to.equal('ch-abc')
    expect(details.recoveryHint).to.equal('run brv bridge connect')
  })

  it('message mentions the member handle and channel id', () => {
    const err = new BridgeInboundOnlyMemberError({
      channelId: 'ch-xyz',
      memberHandle: '@bob',
      recoveryHint: 'some hint',
    })
    expect(err.message).to.include('@bob')
    expect(err.message).to.include('ch-xyz')
  })

  it('is NOT an instance of ChannelInvalidRequestError', async () => {
    const {ChannelInvalidRequestError} = await import('../../../../../src/server/core/domain/channel/errors.js')
    const err = new BridgeInboundOnlyMemberError({
      channelId: 'ch-1',
      memberHandle: '@remote',
      recoveryHint: 'hint',
    })
    expect(err).to.not.be.instanceOf(ChannelInvalidRequestError)
  })
})

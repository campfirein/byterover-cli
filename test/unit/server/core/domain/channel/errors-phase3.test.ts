import {expect} from 'chai'

import {
  CHANNEL_ERROR_CODE,
  ChannelDisabledError,
  ChannelProfileNotFoundError,
  ChannelRequestTimeoutError,
} from '../../../../../../src/server/core/domain/channel/errors.js'

// Slice 3.0 / Phase-3 spec edit — new canonical wire codes plus their
// throwable subclasses. The transport handler forwards `.code` verbatim, so
// the strings here MUST match CHANNEL_PROTOCOL.md §11 exactly.

describe('Phase-3 error subclasses', () => {
  it('ChannelDisabledError.code === CHANNEL_DISABLED', () => {
    expect(new ChannelDisabledError().code).to.equal(CHANNEL_ERROR_CODE.DISABLED)
    expect(CHANNEL_ERROR_CODE.DISABLED).to.equal('CHANNEL_DISABLED')
  })

  it('ChannelRequestTimeoutError.code === CHANNEL_REQUEST_TIMEOUT and carries event + timeoutMs', () => {
    const err = new ChannelRequestTimeoutError('channel:invite', 60_000)
    expect(err.code).to.equal(CHANNEL_ERROR_CODE.REQUEST_TIMEOUT)
    expect(err.event).to.equal('channel:invite')
    expect(err.timeoutMs).to.equal(60_000)
    expect(CHANNEL_ERROR_CODE.REQUEST_TIMEOUT).to.equal('CHANNEL_REQUEST_TIMEOUT')
  })

  it('ChannelProfileNotFoundError.code === CHANNEL_PROFILE_NOT_FOUND and carries profileName', () => {
    const err = new ChannelProfileNotFoundError('kimi')
    expect(err.code).to.equal(CHANNEL_ERROR_CODE.PROFILE_NOT_FOUND)
    expect(err.profileName).to.equal('kimi')
    expect(CHANNEL_ERROR_CODE.PROFILE_NOT_FOUND).to.equal('CHANNEL_PROFILE_NOT_FOUND')
  })
})

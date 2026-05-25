import {expect} from 'chai'

import {
  CHANNEL_ERROR_CODE,
  ChannelDaemonShutdownError,
  ChannelSyncOverflowError,
  ChannelSyncTimeoutError,
  ChannelTurnCancelledError,
} from '../../../../../../src/server/core/domain/channel/errors.js'

// Slice 8.0 / Phase-8 wire codes — sync-mode lifecycle errors surfaced
// via the `{success: false, code}` ack envelope. CHANNEL_PROTOCOL.md
// §13 (code table) gains four new entries.

describe('Phase-8 error subclasses (sync mode lifecycle)', () => {
  it('ChannelSyncTimeoutError.code === CHANNEL_SYNC_TIMEOUT and carries turnId + timeoutMs', () => {
    const err = new ChannelSyncTimeoutError('01HX-abc', 120_000)
    expect(err.code).to.equal(CHANNEL_ERROR_CODE.SYNC_TIMEOUT)
    expect(err.turnId).to.equal('01HX-abc')
    expect(err.timeoutMs).to.equal(120_000)
    expect(CHANNEL_ERROR_CODE.SYNC_TIMEOUT).to.equal('CHANNEL_SYNC_TIMEOUT')
  })

  it('ChannelSyncOverflowError.code === CHANNEL_SYNC_OVERFLOW and carries turnId + byteBudget', () => {
    const err = new ChannelSyncOverflowError('01HX-abc', 1_048_576)
    expect(err.code).to.equal(CHANNEL_ERROR_CODE.SYNC_OVERFLOW)
    expect(err.turnId).to.equal('01HX-abc')
    expect(err.byteBudget).to.equal(1_048_576)
    expect(CHANNEL_ERROR_CODE.SYNC_OVERFLOW).to.equal('CHANNEL_SYNC_OVERFLOW')
  })

  it('ChannelTurnCancelledError.code === CHANNEL_TURN_CANCELLED and carries turnId', () => {
    const err = new ChannelTurnCancelledError('01HX-abc')
    expect(err.code).to.equal(CHANNEL_ERROR_CODE.TURN_CANCELLED)
    expect(err.turnId).to.equal('01HX-abc')
    expect(CHANNEL_ERROR_CODE.TURN_CANCELLED).to.equal('CHANNEL_TURN_CANCELLED')
  })

  it('ChannelDaemonShutdownError.code === CHANNEL_DAEMON_SHUTDOWN', () => {
    const err = new ChannelDaemonShutdownError()
    expect(err.code).to.equal(CHANNEL_ERROR_CODE.DAEMON_SHUTDOWN)
    expect(CHANNEL_ERROR_CODE.DAEMON_SHUTDOWN).to.equal('CHANNEL_DAEMON_SHUTDOWN')
  })

  it('all four new codes are registered in CHANNEL_ERROR_CODE map', () => {
    const codes = Object.values(CHANNEL_ERROR_CODE)
    expect(codes).to.include('CHANNEL_SYNC_TIMEOUT')
    expect(codes).to.include('CHANNEL_SYNC_OVERFLOW')
    expect(codes).to.include('CHANNEL_TURN_CANCELLED')
    expect(codes).to.include('CHANNEL_DAEMON_SHUTDOWN')
  })
})

import {expect} from 'chai'

import {
  CHANNEL_ERROR_CODE,
  ChannelAlreadyExistsError,
  ChannelArchivedError,
  ChannelError,
  ChannelInvalidCursorError,
  ChannelInvalidRequestError,
  ChannelNotFoundError,
  ChannelPermissionLostOnRestartError,
  ChannelPromptEmptyError,
  ChannelTurnNotFoundError,
  ChannelUnauthorizedError,
} from '../../../../../../src/server/core/domain/channel/errors.js'

// Slice 1.3 — channel error hierarchy.
// Every Phase-1 error code from CHANNEL_PROTOCOL.md §11 is reachable as a
// concrete subclass of ChannelError whose `.code` returns the canonical wire
// code. Channel-handler.ts (Slice 1.4) maps these subclasses onto the
// transport error envelope.
describe('ChannelError hierarchy (Slice 1.3 / Phase 1)', () => {
  it('exports the canonical wire codes as a CHANNEL_ERROR_CODE map', () => {
    expect(CHANNEL_ERROR_CODE.UNAUTHORIZED).to.equal('CHANNEL_UNAUTHORIZED')
    expect(CHANNEL_ERROR_CODE.INVALID_REQUEST).to.equal('CHANNEL_INVALID_REQUEST')
    expect(CHANNEL_ERROR_CODE.NOT_FOUND).to.equal('CHANNEL_NOT_FOUND')
    expect(CHANNEL_ERROR_CODE.ALREADY_EXISTS).to.equal('CHANNEL_ALREADY_EXISTS')
    expect(CHANNEL_ERROR_CODE.ARCHIVED).to.equal('CHANNEL_ARCHIVED')
    expect(CHANNEL_ERROR_CODE.INVALID_CURSOR).to.equal('CHANNEL_INVALID_CURSOR')
    expect(CHANNEL_ERROR_CODE.PROMPT_EMPTY).to.equal('CHANNEL_PROMPT_EMPTY')
    expect(CHANNEL_ERROR_CODE.TURN_NOT_FOUND).to.equal('CHANNEL_TURN_NOT_FOUND')
  })

  it('exports CHANNEL_DRIVER_NOT_REGISTERED (Slice 8.11 Layer 1)', () => {
    // V3 super-mario retest documented `unknown` as the surfaced reason on
    // pool.acquire() miss. Slice 8.11 Layer 1 adds a precise wire code so
    // host LLMs can detect the failure and re-invite before retrying.
    expect(CHANNEL_ERROR_CODE.DRIVER_NOT_REGISTERED).to.equal('CHANNEL_DRIVER_NOT_REGISTERED')
  })

  it('ChannelUnauthorizedError exposes the canonical wire code', () => {
    const err = new ChannelUnauthorizedError('missing token')
    expect(err).to.be.instanceOf(ChannelError)
    expect(err).to.be.instanceOf(Error)
    expect(err.code).to.equal('CHANNEL_UNAUTHORIZED')
    expect(err.message).to.include('missing token')
    expect(err.name).to.equal('ChannelUnauthorizedError')
  })

  it('ChannelInvalidRequestError carries structured validation details', () => {
    const issues = {fieldErrors: {channelId: ['Required']}}
    const err = new ChannelInvalidRequestError('payload failed validation', issues)
    expect(err.code).to.equal('CHANNEL_INVALID_REQUEST')
    expect(err.details).to.deep.equal(issues)
  })

  it('ChannelNotFoundError binds the missing channelId on the error', () => {
    const err = new ChannelNotFoundError('pi-missing')
    expect(err.code).to.equal('CHANNEL_NOT_FOUND')
    expect(err.channelId).to.equal('pi-missing')
    expect(err.message).to.include('pi-missing')
  })

  it('ChannelAlreadyExistsError binds the conflicting channelId', () => {
    const err = new ChannelAlreadyExistsError('pi-test')
    expect(err.code).to.equal('CHANNEL_ALREADY_EXISTS')
    expect(err.channelId).to.equal('pi-test')
  })

  it('ChannelArchivedError binds the channelId', () => {
    const err = new ChannelArchivedError('pi-old')
    expect(err.code).to.equal('CHANNEL_ARCHIVED')
    expect(err.channelId).to.equal('pi-old')
  })

  it('ChannelInvalidCursorError exposes the offending cursor', () => {
    const err = new ChannelInvalidCursorError('not-a-cursor')
    expect(err.code).to.equal('CHANNEL_INVALID_CURSOR')
    expect(err.cursor).to.equal('not-a-cursor')
  })

  it('ChannelPromptEmptyError surfaces a message pointing at §8.4 normalisation', () => {
    const err = new ChannelPromptEmptyError()
    expect(err.code).to.equal('CHANNEL_PROMPT_EMPTY')
    expect(err.message).to.match(/prompt/i)
  })

  it('ChannelTurnNotFoundError binds (channelId, turnId)', () => {
    const err = new ChannelTurnNotFoundError('pi-test', '01HX')
    expect(err.code).to.equal('CHANNEL_TURN_NOT_FOUND')
    expect(err.channelId).to.equal('pi-test')
    expect(err.turnId).to.equal('01HX')
  })

  it('every Phase-1 error is also a ChannelError (so handler maps a single type)', () => {
    expect(new ChannelUnauthorizedError('x')).to.be.instanceOf(ChannelError)
    expect(new ChannelInvalidRequestError('x', {})).to.be.instanceOf(ChannelError)
    expect(new ChannelNotFoundError('x')).to.be.instanceOf(ChannelError)
    expect(new ChannelAlreadyExistsError('x')).to.be.instanceOf(ChannelError)
    expect(new ChannelArchivedError('x')).to.be.instanceOf(ChannelError)
    expect(new ChannelInvalidCursorError('x')).to.be.instanceOf(ChannelError)
    expect(new ChannelPromptEmptyError()).to.be.instanceOf(ChannelError)
    expect(new ChannelTurnNotFoundError('x', 'y')).to.be.instanceOf(ChannelError)
  })
})

// Slice 8.10 — daemon-restart permission recovery. When the brv daemon
// restarts mid-turn with a delivery in `awaiting_permission`, the ACP
// subprocess dies and the in-memory `activeTurns` Map is lost. The
// approve path should distinguish this case from a true "turn never existed"
// lookup miss so the host LLM can recover via the Slice 8.9 cursor flow.
// See plan/channel-protocol/IMPLEMENTATION_PHASE_8_FOLLOWUPS.md §"Slice 8.10".
// eslint-disable-next-line mocha/max-top-level-suites
describe('ChannelPermissionLostOnRestartError (Slice 8.10)', () => {
  it('exposes the new wire code CHANNEL_PERMISSION_LOST_ON_RESTART', () => {
    expect(CHANNEL_ERROR_CODE.PERMISSION_LOST_ON_RESTART).to.equal('CHANNEL_PERMISSION_LOST_ON_RESTART')
  })

  it('binds (channelId, turnId, permissionRequestId, erroredSeq) on the error', () => {
    const err = new ChannelPermissionLostOnRestartError('pubsub-review', 'turn-xyz', 'perm-abc', 7)
    expect(err.code).to.equal('CHANNEL_PERMISSION_LOST_ON_RESTART')
    expect(err.channelId).to.equal('pubsub-review')
    expect(err.turnId).to.equal('turn-xyz')
    expect(err.permissionRequestId).to.equal('perm-abc')
    expect(err.erroredSeq).to.equal(7)
    expect(err).to.be.instanceOf(ChannelError)
    expect(err.name).to.equal('ChannelPermissionLostOnRestartError')
  })

  it('embeds the exclusive --after-seq recovery cursor in the human message (codex Q6 cursor fix)', () => {
    // `subscribe --after-seq` is exclusive (event.seq > afterSeq). To replay
    // the just-emitted errored event at seq=N, the user passes --after-seq N-1.
    const err = new ChannelPermissionLostOnRestartError('ch', 'turn-1', 'perm-1', 7)
    expect(err.message).to.match(/--after-seq 6\b/)
    expect(err.message).to.include('turn-1')
  })

  it('interpolates channelId into the recovery-cursor command (codex impl-review fix: was previously a literal "<channelId>" placeholder)', () => {
    const err = new ChannelPermissionLostOnRestartError('my-channel', 'turn-1', 'perm-1', 7)
    expect(err.message).to.match(/brv channel subscribe my-channel /)
    expect(err.message).to.not.match(/<channelId>/)
  })

  it('tells the host to re-invite AND re-mention (codex Q5: not retry, re-invite needed)', () => {
    const err = new ChannelPermissionLostOnRestartError('ch', 'turn-1', 'perm-1', 5)
    expect(err.message).to.match(/re-invite/i)
    expect(err.message).to.match(/re-mention/i)
  })

  it('exposes the structured details payload for transport serialisation', () => {
    const err = new ChannelPermissionLostOnRestartError('ch', 'turn-1', 'perm-1', 5)
    expect(err.details).to.deep.equal({
      channelId: 'ch',
      erroredSeq: 5,
      permissionRequestId: 'perm-1',
      turnId: 'turn-1',
    })
  })
})

import {expect} from 'chai'

import {reconstructTurnFromEvents} from '../../../../../../src/server/core/domain/channel/turn-reconstruction.js'
import {TurnSchema} from '../../../../../../src/shared/types/channel.js'
import {makeMessageEvent, makeStateChangeEvent} from '../../../../../helpers/channel-fixtures.js'

describe('reconstructTurnFromEvents', () => {
  it('reconstructs promptBlocks from the first message event', () => {
    const turn = reconstructTurnFromEvents({
      channelId: 'ch1',
      events: [makeMessageEvent({content: 'hi', seq: 0}), makeStateChangeEvent({seq: 1, to: 'completed'})],
      turnId: 't1',
    })
    expect(turn.promptBlocks).to.deep.equal([{text: 'hi', type: 'text'}])
  })

  it('derives state from the last turn_state_change', () => {
    const turn = reconstructTurnFromEvents({
      channelId: 'ch1',
      events: [
        makeStateChangeEvent({from: 'pending', seq: 0, to: 'dispatched'}),
        makeStateChangeEvent({from: 'dispatched', seq: 1, to: 'completed'}),
      ],
      turnId: 't1',
    })
    expect(turn.state).to.equal('completed')
  })

  it('sets endedAt only for terminal states', () => {
    const terminal = reconstructTurnFromEvents({
      channelId: 'ch1',
      events: [makeStateChangeEvent({emittedAt: '2026-05-25T10:00:09.000Z', seq: 0, to: 'completed'})],
      turnId: 't1',
    })
    expect(terminal.endedAt).to.equal('2026-05-25T10:00:09.000Z')

    const nonTerminal = reconstructTurnFromEvents({
      channelId: 'ch1',
      events: [makeStateChangeEvent({from: 'pending', seq: 0, to: 'dispatched'})],
      turnId: 't1',
    })
    expect(nonTerminal.endedAt).to.equal(undefined)
  })

  it('takes startedAt from the first event', () => {
    const turn = reconstructTurnFromEvents({
      channelId: 'ch1',
      events: [
        makeMessageEvent({emittedAt: '2026-05-25T10:00:00.500Z', seq: 0}),
        makeStateChangeEvent({seq: 1, to: 'completed'}),
      ],
      turnId: 't1',
    })
    expect(turn.startedAt).to.equal('2026-05-25T10:00:00.500Z')
  })

  it('falls back to a local-user author when events carry no author', () => {
    const turn = reconstructTurnFromEvents({
      channelId: 'ch1',
      events: [makeMessageEvent({seq: 0})],
      turnId: 't1',
    })
    expect(turn.author).to.deep.equal({handle: 'you', kind: 'local-user'})
    expect(turn.promptedBy).to.equal('user')
  })

  it('handles an empty event list defensively', () => {
    const turn = reconstructTurnFromEvents({channelId: 'ch1', events: [], turnId: 't1'})
    expect(turn.state).to.equal('pending')
    expect(turn.promptBlocks).to.deep.equal([])
    expect(turn.startedAt).to.equal(new Date(0).toISOString())
    expect(turn.endedAt).to.equal(undefined)
  })

  it('produces a Turn that satisfies TurnSchema and threads channelId/turnId', () => {
    const turn = reconstructTurnFromEvents({
      channelId: 'ch-x',
      events: [makeMessageEvent({seq: 0}), makeStateChangeEvent({seq: 1, to: 'completed'})],
      turnId: 'turn-x',
    })
    expect(() => TurnSchema.parse(turn)).to.not.throw()
    expect(turn.channelId).to.equal('ch-x')
    expect(turn.turnId).to.equal('turn-x')
  })
})

import {expect} from 'chai'

import {ChannelClientError, type TurnEvent} from '@brv/channel-client'

import {dispatchChannelCommand} from '../src/commands.js'
import {makeStubClient, makeStubConnect, makeStubCtx} from './helpers/stub-client.js'

describe('dispatchChannelCommand (Slice 7.1a)', () => {
  describe('no subcommand', () => {
    it('prints usage when args is empty', async () => {
      const stub = makeStubClient()
      const {ctx, notifications} = makeStubCtx()
      await dispatchChannelCommand('', ctx, makeStubConnect(stub))
      expect(notifications).to.have.lengthOf(1)
      expect(notifications[0]!.message).to.contain('Usage:')
      expect(notifications[0]!.level).to.equal('warning')
    })
  })

  describe('/channel new', () => {
    it('emits channel:create with the channelId', async () => {
      const stub = makeStubClient()
      const {ctx, notifications} = makeStubCtx()
      await dispatchChannelCommand('new pi-review', ctx, makeStubConnect(stub))
      expect(stub.requests).to.deep.equal([
        {data: {channelId: 'pi-review'}, event: 'channel:create'},
      ])
      expect(notifications.map((n) => n.message)).to.deep.equal([
        '✓ Channel #pi-review created',
      ])
    })

    it('warns when channelId is missing', async () => {
      const stub = makeStubClient()
      const {ctx, notifications} = makeStubCtx()
      await dispatchChannelCommand('new', ctx, makeStubConnect(stub))
      expect(stub.requests).to.have.lengthOf(0)
      expect(notifications[0]!.level).to.equal('warning')
    })
  })

  describe('/channel list', () => {
    it('renders one notify line per channel', async () => {
      const stub = makeStubClient()
      stub.prime('channel:list', {
        channels: [
          {channelId: 'a', state: 'active', title: 'Alpha'},
          {channelId: 'b', state: 'archived'},
        ],
      })
      const {ctx, notifications} = makeStubCtx()
      await dispatchChannelCommand('list', ctx, makeStubConnect(stub))
      expect(notifications.map((n) => n.message)).to.deep.equal([
        'a  [active]  Alpha',
        'b  [archived]',
      ])
    })

    it('renders an empty-state notify when there are no channels', async () => {
      const stub = makeStubClient()
      stub.prime('channel:list', {channels: []})
      const {ctx, notifications} = makeStubCtx()
      await dispatchChannelCommand('list', ctx, makeStubConnect(stub))
      expect(notifications[0]!.message).to.contain('no channels')
    })
  })

  describe('/channel invite', () => {
    it('emits channel:invite with --profile flag', async () => {
      const stub = makeStubClient()
      const {ctx} = makeStubCtx()
      await dispatchChannelCommand('invite pi-review @echo --profile echo', ctx, makeStubConnect(stub))
      expect(stub.requests).to.deep.equal([
        {
          data: {channelId: 'pi-review', memberHandle: '@echo', profile: 'echo'},
          event: 'channel:invite',
        },
      ])
    })

    it('warns when --profile is omitted', async () => {
      const stub = makeStubClient()
      const {ctx, notifications} = makeStubCtx()
      await dispatchChannelCommand('invite pi-review @echo', ctx, makeStubConnect(stub))
      expect(stub.requests).to.have.lengthOf(0)
      expect(notifications[0]!.level).to.equal('warning')
    })
  })

  describe('/channel mention', () => {
    it('emits channel:mention, then subscribes + renders the turn', async () => {
      const stub = makeStubClient()
      stub.prime('channel:mention', {turn: {turnId: '01HX-turn'}})
      const events: TurnEvent[] = [
        {channelId: 'pi-review', content: 'hi', deliveryId: 'd', emittedAt: 't', kind: 'agent_message_chunk', memberHandle: '@echo', seq: 1, turnId: '01HX-turn'},
        {channelId: 'pi-review', deliveryId: null, emittedAt: 't', from: 'dispatched', kind: 'turn_state_change', memberHandle: null, seq: 2, to: 'completed', turnId: '01HX-turn'},
      ]
      stub.primeTurnEvents(events)
      const {ctx, notifications} = makeStubCtx({cwd: '/code/pi-project'})
      await dispatchChannelCommand('mention pi-review "@echo hi"', ctx, makeStubConnect(stub))
      expect(stub.requests).to.deep.equal([
        {
          data: {channelId: 'pi-review', projectRoot: '/code/pi-project', prompt: '@echo hi'},
          event: 'channel:mention',
        },
      ])
      const messages = notifications.map((n) => n.message)
      expect(messages[0]).to.contain('turn 01HX-turn started')
      expect(messages).to.include('[@echo] hi')
      expect(messages).to.include('turn 01HX-turn completed')
    })
  })

  describe('/channel approve + /channel deny', () => {
    it('approve emits channel:permission-decision with decision allow_once', async () => {
      const stub = makeStubClient()
      const {ctx} = makeStubCtx()
      await dispatchChannelCommand('approve pi-review 01HX-t perm-1', ctx, makeStubConnect(stub))
      expect(stub.requests).to.deep.equal([
        {
          data: {channelId: 'pi-review', decision: 'allow_once', permissionId: 'perm-1', turnId: '01HX-t'},
          event: 'channel:permission-decision',
        },
      ])
    })

    it('deny emits channel:permission-decision with decision reject_once', async () => {
      const stub = makeStubClient()
      const {ctx} = makeStubCtx()
      await dispatchChannelCommand('deny pi-review 01HX-t perm-1', ctx, makeStubConnect(stub))
      expect(stub.requests).to.deep.equal([
        {
          data: {channelId: 'pi-review', decision: 'reject_once', permissionId: 'perm-1', turnId: '01HX-t'},
          event: 'channel:permission-decision',
        },
      ])
    })
  })

  describe('/channel show', () => {
    it('renders one line per stored event', async () => {
      const stub = makeStubClient()
      stub.prime('channel:get-turn', {
        events: [
          {channelId: 'pi-review', kind: 'agent_message_chunk', content: 'hello there', seq: 1, turnId: '01HX-t'},
          {channelId: 'pi-review', kind: 'turn_state_change', seq: 2, to: 'completed', turnId: '01HX-t'},
        ],
      })
      const {ctx, notifications} = makeStubCtx()
      await dispatchChannelCommand('show pi-review 01HX-t', ctx, makeStubConnect(stub))
      expect(notifications.map((n) => n.message)).to.have.lengthOf(2)
      expect(notifications[0]!.message).to.contain('kind=agent_message_chunk')
      expect(notifications[1]!.message).to.contain('to=completed')
    })
  })

  describe('/channel doctor', () => {
    it('lists each profile with its ok/reason', async () => {
      const stub = makeStubClient()
      stub.prime('channel:doctor', {
        profiles: [
          {name: 'echo', ok: true},
          {name: 'kimi', ok: false, reason: 'binary not found'},
        ],
      })
      const {ctx, notifications} = makeStubCtx()
      await dispatchChannelCommand('doctor', ctx, makeStubConnect(stub))
      expect(notifications.map((n) => n.message)).to.deep.equal([
        '✓ echo',
        '✗ kimi — binary not found',
      ])
    })

    it('forwards --profile when supplied', async () => {
      const stub = makeStubClient()
      stub.prime('channel:doctor', {profiles: []})
      const {ctx} = makeStubCtx()
      await dispatchChannelCommand('doctor --profile echo', ctx, makeStubConnect(stub))
      expect(stub.requests[0]!.data).to.deep.equal({profile: 'echo'})
    })
  })

  describe('error handling', () => {
    it('surfaces ChannelClientError as an error-level notify', async () => {
      const stub = makeStubClient()
      stub.primeFailure('channel:create', new ChannelClientError('CHANNEL_ALREADY_EXISTS', 'Channel #x already exists'))
      const {ctx, notifications} = makeStubCtx()
      await dispatchChannelCommand('new x', ctx, makeStubConnect(stub))
      expect(notifications[0]!.level).to.equal('error')
      expect(notifications[0]!.message).to.contain('[CHANNEL_ALREADY_EXISTS]')
      expect(stub.closed).to.equal(true)
    })

    it('warns on unknown subcommand', async () => {
      const stub = makeStubClient()
      const {ctx, notifications} = makeStubCtx()
      await dispatchChannelCommand('whoops', ctx, makeStubConnect(stub))
      expect(notifications[0]!.level).to.equal('warning')
      expect(notifications[0]!.message).to.contain('Unknown subcommand')
    })
  })
})

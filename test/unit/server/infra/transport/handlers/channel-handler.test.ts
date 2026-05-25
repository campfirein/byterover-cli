import {expect} from 'chai'

import type {IChannelOrchestrator} from '../../../../../../src/server/core/interfaces/channel/i-channel-orchestrator.js'
import type {RequestContext, RequestHandler} from '../../../../../../src/server/core/interfaces/transport/i-transport-server.js'
import type {Channel, Turn, TurnEvent} from '../../../../../../src/shared/types/channel.js'

import {ChannelNotFoundError, ChannelUnauthorizedError} from '../../../../../../src/server/core/domain/channel/errors.js'
import {ChannelHandler} from '../../../../../../src/server/infra/transport/handlers/channel-handler.js'
import {ChannelEvents} from '../../../../../../src/shared/transport/events/channel-events.js'

// Slice 1.4 — channel-handler registers the 7 Phase-1 client-to-host events
// behind the daemon-token auth middleware, validates payloads against the
// channel-events zod schemas, delegates to the orchestrator, and maps
// ChannelError subclasses onto the transport error envelope.
describe('ChannelHandler (Slice 1.4)', () => {
  const AUTH_TOKEN = 'test-daemon-token'
  const CWD = '/tmp/scratch'

  let registeredHandlers: Map<string, RequestHandler<unknown, unknown>>
  let orchestratorCalls: Array<{args: unknown; method: string;}>
  let handler: ChannelHandler

  const fakeTransport = (): {
    onRequest: <TReq, TRes>(event: string, h: RequestHandler<TReq, TRes>) => void
  } => ({
    onRequest<TReq, TRes>(event: string, h: RequestHandler<TReq, TRes>) {
      registeredHandlers.set(event, h as RequestHandler<unknown, unknown>)
    },
  })

  const sampleChannel: Channel = {
    channelId: 'pi-test',
    createdAt: '2026-05-11T00:00:00.000Z',
    memberCount: 0,
    members: [],
    title: undefined,
    updatedAt: '2026-05-11T00:00:00.000Z',
  }

  const sampleTurn: Turn = {
    author: {handle: 'you', kind: 'local-user'},
    channelId: 'pi-test',
    endedAt: '2026-05-11T00:00:01.000Z',
    mentions: [],
    promptBlocks: [{text: 'hi', type: 'text'}],
    promptedBy: 'user',
    startedAt: '2026-05-11T00:00:00.000Z',
    state: 'completed',
    turnId: '01HX',
  }

  const sampleEvents: TurnEvent[] = [
    {
      channelId: 'pi-test',
      content: 'hi',
      deliveryId: null,
      emittedAt: '2026-05-11T00:00:00.000Z',
      kind: 'message',
      memberHandle: null,
      role: 'user',
      seq: 0,
      turnId: '01HX',
    } as TurnEvent,
  ]

  const orchestrator: IChannelOrchestrator = {
    async archiveChannel(args) {
      orchestratorCalls.push({args, method: 'archiveChannel'})
      return {...sampleChannel, archivedAt: '2026-05-11T00:00:02.000Z'}
    },
    async awaitSyncMention(turnId) {
      orchestratorCalls.push({args: {turnId}, method: 'awaitSyncMention'})
      return {
        channelId: 'pi-test',
        durationMs: 100,
        endedState: 'completed',
        finalAnswer: 'mock-sync-answer',
        toolCalls: [],
        turnId,
      }
    },
    async cancelTurn(args) {
      orchestratorCalls.push({args, method: 'cancelTurn'})
      return {deliveries: [], turn: sampleTurn}
    },
    async createChannel(args) {
      orchestratorCalls.push({args, method: 'createChannel'})
      return sampleChannel
    },
    async dispatchMention(args) {
      orchestratorCalls.push({args, method: 'dispatchMention'})
      return {deliveries: [], turn: sampleTurn}
    },
    async dispatchOne(args) {
      orchestratorCalls.push({args, method: 'dispatchOne'})
      return {
        deliveryId: 'd-stub',
        terminal: Promise.resolve({
          artifactsTouched: [],
          deliveryId: 'd-stub',
          endedAt: '2026-05-18T00:00:00.000Z',
          finalAnswer: 'stub',
          memberHandle: args.memberHandle,
          state: 'completed' as const,
          toolCallCount: 0,
        }),
        turnId: 't-stub',
      }
    },
    async getChannel(args) {
      orchestratorCalls.push({args, method: 'getChannel'})
      return sampleChannel
    },
    async getTurn(args) {
      orchestratorCalls.push({args, method: 'getTurn'})
      return {events: sampleEvents, turn: sampleTurn}
    },
    async inviteMember(args) {
      orchestratorCalls.push({args, method: 'inviteMember'})
      return {
        agentName: '@mock',
        capabilities: [],
        driverClass: 'C-prime',
        handle: '@mock',
        invocation: {args: [], command: 'node', cwd: '/tmp'},
        joinedAt: '2026-05-11T00:00:00.000Z',
        memberKind: 'acp-agent',
        status: 'idle',
      } as never
    },
    async listChannels(args) {
      orchestratorCalls.push({args, method: 'listChannels'})
      return [sampleChannel]
    },
    async listTurns(args) {
      orchestratorCalls.push({args, method: 'listTurns'})
      return {turns: [sampleTurn]}
    },
    async permissionDecision(args) {
      orchestratorCalls.push({args, method: 'permissionDecision'})
      return sampleEvents[0]
    },
    async postTurn(args) {
      orchestratorCalls.push({args, method: 'postTurn'})
      return sampleTurn
    },
    async uninviteMember(args) {
      orchestratorCalls.push({args, method: 'uninviteMember'})
      return {
        agentName: '@mock',
        capabilities: [],
        driverClass: 'C-prime',
        handle: '@mock',
        invocation: {args: [], command: 'node', cwd: '/tmp'},
        joinedAt: '2026-05-11T00:00:00.000Z',
        memberKind: 'acp-agent',
        status: 'left',
      } as never
    },
  }

  const validCtx: RequestContext = {
    auth: {token: AUTH_TOKEN},
    cwd: CWD,
    transport: 'socket.io',
  }

  beforeEach(() => {
    registeredHandlers = new Map()
    orchestratorCalls = []
    handler = new ChannelHandler({authToken: AUTH_TOKEN, orchestrator})
    handler.registerOn(fakeTransport() as never)
  })

  // ─── Registration shape ─────────────────────────────────────────────────

  it('registers every Phase-1 + Phase-2 + Phase-3 client-to-host event handler', () => {
    const wireEvents = [
      // Phase 1
      ChannelEvents.CREATE,
      ChannelEvents.LIST,
      ChannelEvents.GET,
      ChannelEvents.ARCHIVE,
      ChannelEvents.POST,
      ChannelEvents.LIST_TURNS,
      ChannelEvents.GET_TURN,
      // Phase 2
      ChannelEvents.INVITE,
      ChannelEvents.UNINVITE,
      ChannelEvents.MENTION,
      ChannelEvents.CANCEL,
      ChannelEvents.PERMISSION_DECISION,
      // Phase 10 Slice 10.2 — quorum dispatch.
      ChannelEvents.MENTION_QUORUM,
      // Phase 10 Slice 10.7 — read persisted quorum result.
      ChannelEvents.SHOW_QUORUM,
      // Phase 3 — onboard / doctor / profile-* / rotate-token. Slice 3.5 will
      // add `channel:members` (deferred until then).
      ChannelEvents.ONBOARD,
      ChannelEvents.DOCTOR,
      ChannelEvents.PROFILE_LIST,
      ChannelEvents.PROFILE_SHOW,
      ChannelEvents.PROFILE_REMOVE,
      // Phase 10 Tier B3 — drift observations.
      ChannelEvents.PROFILE_RECORD_DRIFT,
      ChannelEvents.PROFILE_CLEAR_DRIFT,
      ChannelEvents.ROTATE_TOKEN,
    ]
    for (const event of wireEvents) {
      expect(registeredHandlers.has(event), `missing handler for ${event}`).to.equal(true)
    }

    expect(registeredHandlers.size).to.equal(wireEvents.length)
  })

  it('does NOT register the future channel:members surface (deferred to Phase 3.5+)', () => {
    expect(registeredHandlers.has(ChannelEvents.MEMBERS)).to.equal(false)
  })

  // ─── Auth ────────────────────────────────────────────────────────────────

  it('rejects channel:* requests without a token with CHANNEL_UNAUTHORIZED', async () => {
    const h = registeredHandlers.get(ChannelEvents.CREATE)!
    let threw: unknown
    try {
      await h({channelId: 'pi-test'}, 'client-1', {transport: 'socket.io'})
    } catch (error) {
      threw = error
    }

    expect(threw).to.be.instanceOf(ChannelUnauthorizedError)
    expect(orchestratorCalls).to.have.lengthOf(0)
  })

  it('rejects channel:* requests with a wrong token with CHANNEL_UNAUTHORIZED', async () => {
    const h = registeredHandlers.get(ChannelEvents.CREATE)!
    let threw: unknown
    try {
      await h(
        {channelId: 'pi-test'},
        'client-1',
        {auth: {token: 'bogus'}, transport: 'socket.io'},
      )
    } catch (error) {
      threw = error
    }

    expect(threw).to.be.instanceOf(ChannelUnauthorizedError)
  })

  // ─── Per-event delegation ───────────────────────────────────────────────

  it('channel:create — validates and delegates to orchestrator.createChannel', async () => {
    const h = registeredHandlers.get(ChannelEvents.CREATE)!
    const response = (await h({channelId: 'pi-test'}, 'client-1', validCtx)) as {channel: Channel}

    expect(orchestratorCalls).to.deep.equal([
      {args: {channelId: 'pi-test', projectRoot: CWD, title: undefined}, method: 'createChannel'},
    ])
    expect(response.channel.channelId).to.equal('pi-test')
  })

  it('channel:list — delegates with the archived flag', async () => {
    const h = registeredHandlers.get(ChannelEvents.LIST)!
    const response = (await h({archived: true}, 'client-1', validCtx)) as {channels: Channel[]}

    expect(orchestratorCalls[0].method).to.equal('listChannels')
    expect((orchestratorCalls[0].args as {archived: boolean}).archived).to.equal(true)
    expect(response.channels).to.have.lengthOf(1)
  })

  it('channel:get — requires channelId; rejects empty payload with CHANNEL_INVALID_REQUEST', async () => {
    const h = registeredHandlers.get(ChannelEvents.GET)!

    let threw: unknown
    try {
      await h({}, 'client-1', validCtx)
    } catch (error) {
      threw = error
    }

    expect(threw).to.be.an.instanceOf(Error)
    expect(((threw as {code?: string}).code)).to.equal('CHANNEL_INVALID_REQUEST')
    expect(orchestratorCalls).to.have.lengthOf(0)
  })

  it('channel:post — delegates with prompt and promptBlocks', async () => {
    const h = registeredHandlers.get(ChannelEvents.POST)!
    await h(
      {channelId: 'pi-test', prompt: 'note'},
      'client-1',
      validCtx,
    )

    expect(orchestratorCalls[0].method).to.equal('postTurn')
    expect((orchestratorCalls[0].args as {prompt: string}).prompt).to.equal('note')
  })

  it('channel:list-turns — delegates with optional cursor/limit', async () => {
    const h = registeredHandlers.get(ChannelEvents.LIST_TURNS)!
    const response = (await h(
      {channelId: 'pi-test', limit: 10},
      'client-1',
      validCtx,
    )) as {turns: Turn[]}

    expect(orchestratorCalls[0].method).to.equal('listTurns')
    expect(response.turns).to.have.lengthOf(1)
  })

  it('channel:get-turn — returns turn + events', async () => {
    const h = registeredHandlers.get(ChannelEvents.GET_TURN)!
    const response = (await h(
      {channelId: 'pi-test', turnId: '01HX'},
      'client-1',
      validCtx,
    )) as {events: TurnEvent[]; turn: Turn}

    expect(response.turn.turnId).to.equal('01HX')
    expect(response.events).to.have.lengthOf(1)
  })

  it('rejects requests with no cwd in context (channel handlers need a project root)', async () => {
    const h = registeredHandlers.get(ChannelEvents.CREATE)!
    let threw: unknown
    try {
      await h({channelId: 'pi-test'}, 'client-1', {auth: {token: AUTH_TOKEN}, transport: 'socket.io'})
    } catch (error) {
      threw = error
    }

    expect(threw).to.be.an.instanceOf(Error)
    expect(((threw as {code?: string}).code)).to.equal('CHANNEL_INVALID_REQUEST')
  })

  // ─── Error mapping ───────────────────────────────────────────────────────

  it('propagates ChannelError subclasses thrown by the orchestrator', async () => {
    const failingOrchestrator: IChannelOrchestrator = {
      ...orchestrator,
      async getChannel() {
        throw new ChannelNotFoundError('nope')
      },
    }
    const localHandler = new ChannelHandler({authToken: AUTH_TOKEN, orchestrator: failingOrchestrator})
    const localRegistered = new Map<string, RequestHandler<unknown, unknown>>()
    localHandler.registerOn({
      onRequest<TReq, TRes>(event: string, h: RequestHandler<TReq, TRes>) {
        localRegistered.set(event, h as RequestHandler<unknown, unknown>)
      },
    } as never)

    const h = localRegistered.get(ChannelEvents.GET)!
    let threw: unknown
    try {
      await h({channelId: 'nope'}, 'client-1', validCtx)
    } catch (error) {
      threw = error
    }

    expect(threw).to.be.instanceOf(ChannelNotFoundError)
    expect(((threw as ChannelNotFoundError).code)).to.equal('CHANNEL_NOT_FOUND')
  })
})

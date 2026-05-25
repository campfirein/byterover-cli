import type {
  ContentBlock,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk'
import {expect} from 'chai'

import type {PromptContext} from '../src/prompt-context.js'

import {ChannelAgent} from '../src/index.js'
import {createPairedStreams} from './helpers/paired-streams.js'

// Slice 5.1 — ChannelAgent surface, driven outside-in by the 25-LOC echo
// example. Every test corresponds 1:1 to a behavior the example needs.

const flush = async (): Promise<void> => new Promise((r) => setImmediate(r))

describe('ChannelAgent (Slice 5.1)', () => {
  it('exposes onPrompt, onCancel, run — and NOT onSessionEnd (outside-in surface)', () => {
    const agent = new ChannelAgent({name: 'echo', promptCapabilities: {}, version: '0.1.0'})
    expect(typeof agent.onPrompt).to.equal('function')
    expect(typeof agent.onCancel).to.equal('function')
    expect(typeof agent.run).to.equal('function')
    expect((agent as unknown as {onSessionEnd?: unknown}).onSessionEnd).to.equal(undefined)
  })

  it('initialize → echoes configured promptCapabilities', async () => {
    const agent = new ChannelAgent({
      name: 'echo',
      promptCapabilities: {embeddedContext: true, image: true},
      version: '0.1.0',
    })
    const rig = createPairedStreams()
    agent.onPrompt(async () => ({stopReason: 'end_turn'}))
    agent.run({stream: rig.agentStream})
    const client = rig.connect(() => stubClient())
    const result = await client.initialize({
      clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false},
      protocolVersion: 1,
    })
    expect(result.protocolVersion).to.equal(1)
    expect(result.agentCapabilities?.promptCapabilities).to.deep.equal({embeddedContext: true, image: true})
    expect(result.agentInfo?.name).to.equal('echo')
    expect(result.agentInfo?.version).to.equal('0.1.0')
    rig.close()
  })

  it('session/new → returns a UUID-shaped sessionId', async () => {
    const agent = new ChannelAgent({name: 'echo', promptCapabilities: {}, version: '0.1.0'})
    const rig = createPairedStreams()
    agent.onPrompt(async () => ({stopReason: 'end_turn'}))
    agent.run({stream: rig.agentStream})
    const client = rig.connect(() => stubClient())
    await client.initialize({
      clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false},
      protocolVersion: 1,
    })
    const result = await client.newSession({cwd: '/tmp', mcpServers: []})
    expect(result.sessionId).to.be.a('string')
    expect(result.sessionId).to.match(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i)
    rig.close()
  })

  it('session/prompt → ctx.sendMessageChunk emits a notification BEFORE the prompt response', async () => {
    const agent = new ChannelAgent({name: 'echo', promptCapabilities: {}, version: '0.1.0'})
    const rig = createPairedStreams()
    agent.onPrompt(async (req, ctx) => {
      const userText = req.prompt
        .filter((b: ContentBlock) => b.type === 'text')
        .map((b: ContentBlock) => (b as {text: string}).text)
        .join(' ')
      await ctx.sendMessageChunk(`you said: ${userText}`)
      return {stopReason: 'end_turn'}
    })
    agent.run({stream: rig.agentStream})

    const notifications: SessionNotification[] = []
    const client = rig.connect(() =>
      stubClient({
        async sessionUpdate(n: SessionNotification): Promise<void> {
          notifications.push(n)
        },
      }),
    )

    await client.initialize({
      clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false},
      protocolVersion: 1,
    })
    const {sessionId} = await client.newSession({cwd: '/tmp', mcpServers: []})
    const reply = (await client.prompt({
      prompt: [{text: 'hi there', type: 'text'}],
      sessionId,
    })) as PromptResponse
    expect(reply.stopReason).to.equal('end_turn')

    // The notification MUST be delivered before the prompt promise resolves.
    expect(notifications).to.have.lengthOf(1)
    const first = notifications[0]
    expect(first).to.not.equal(undefined)
    const update = first!.update
    expect(update.sessionUpdate).to.equal('agent_message_chunk')
    const content = (update as {content: {text: string; type: string}}).content
    expect(content.type).to.equal('text')
    expect(content.text).to.equal('you said: hi there')
    rig.close()
  })

  it('ctx.requestPermission round-trips with the host', async () => {
    const agent = new ChannelAgent({name: 'echo', promptCapabilities: {}, version: '0.1.0'})
    const rig = createPairedStreams()
    let permissionRequest: RequestPermissionRequest | undefined
    agent.onPrompt(async (_req, ctx) => {
      const outcome = await ctx.requestPermission({
        options: [
          {kind: 'allow_once', name: 'Approve', optionId: 'approve'},
          {kind: 'reject_once', name: 'Reject', optionId: 'reject'},
        ],
        toolCall: {kind: 'edit', title: 'WriteFile: /tmp/x', toolCallId: 'tc-1'},
      })
      if (outcome.outcome === 'selected' && outcome.optionId === 'approve') {
        await ctx.sendMessageChunk('approved')
      }

      return {stopReason: 'end_turn'}
    })
    agent.run({stream: rig.agentStream})

    const client = rig.connect(() =>
      stubClient({
        async requestPermission(req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
          permissionRequest = req
          return {outcome: {optionId: 'approve', outcome: 'selected'}}
        },
      }),
    )

    await client.initialize({
      clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false},
      protocolVersion: 1,
    })
    const {sessionId} = await client.newSession({cwd: '/tmp', mcpServers: []})
    const reply = (await client.prompt({
      prompt: [{text: 'do it', type: 'text'}],
      sessionId,
    })) as PromptResponse
    expect(reply.stopReason).to.equal('end_turn')
    expect(permissionRequest?.toolCall.toolCallId).to.equal('tc-1')
    expect(permissionRequest?.options).to.have.lengthOf(2)
    rig.close()
  })

  it('agent.onCancel — session/cancel notification fires the registered handler', async () => {
    const agent = new ChannelAgent({name: 'echo', promptCapabilities: {}, version: '0.1.0'})
    const rig = createPairedStreams()
    let cancelled = false
    agent.onCancel(async () => {
      cancelled = true
    })
    // Use a never-resolving prompt so cancel arrives mid-flight.
    let cancelInPromptObserved = false
    agent.onPrompt(async (_req, ctx) => {
      try {
        await new Promise<void>((resolve, reject) => {
          ctx.signal.addEventListener('abort', () => {
            cancelInPromptObserved = true
            reject(new Error('cancelled'))
          })
        })
        return {stopReason: 'end_turn'}
      } catch {
        return {stopReason: 'cancelled'}
      }
    })
    agent.run({stream: rig.agentStream})
    const client = rig.connect(() => stubClient())
    await client.initialize({
      clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false},
      protocolVersion: 1,
    })
    const {sessionId} = await client.newSession({cwd: '/tmp', mcpServers: []})
    const promptPromise = client.prompt({prompt: [{text: 'wait', type: 'text'}], sessionId})
    await flush()
    await client.cancel({sessionId})
    await promptPromise
    expect(cancelled).to.equal(true)
    expect(cancelInPromptObserved).to.equal(true)
    rig.close()
  })

  it('ctx.sendMessageChunk after the prompt handler returns throws a clear error', async () => {
    const agent = new ChannelAgent({name: 'echo', promptCapabilities: {}, version: '0.1.0'})
    const rig = createPairedStreams()
    let escapedCtx: PromptContext | undefined
    agent.onPrompt(async (_req, ctx) => {
      escapedCtx = ctx
      return {stopReason: 'end_turn'}
    })
    agent.run({stream: rig.agentStream})
    const client = rig.connect(() => stubClient())
    await client.initialize({
      clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false},
      protocolVersion: 1,
    })
    const {sessionId} = await client.newSession({cwd: '/tmp', mcpServers: []})
    await client.prompt({prompt: [{text: 'hi', type: 'text'}], sessionId})
    expect(escapedCtx).to.not.equal(undefined)
    let caught: unknown
    try {
      await escapedCtx?.sendMessageChunk('too late')
    } catch (error) {
      caught = error
    }

    expect(caught).to.be.instanceOf(Error)
    expect((caught as Error).message).to.match(/after.*prompt.*ended|out-of-prompt/i)
    rig.close()
  })
})

// Minimal stub Client. Tests override the fields they care about.
const stubClient = (overrides: Partial<{
  requestPermission: (req: RequestPermissionRequest) => Promise<RequestPermissionResponse>
  sessionUpdate: (n: SessionNotification) => Promise<void>
}> = {}): import('@agentclientprotocol/sdk').Client => ({
  async requestPermission(req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (overrides.requestPermission !== undefined) return overrides.requestPermission(req)
    return {outcome: {outcome: 'cancelled'}}
  },
  async sessionUpdate(n: SessionNotification): Promise<void> {
    if (overrides.sessionUpdate !== undefined) await overrides.sessionUpdate(n)
  },
})

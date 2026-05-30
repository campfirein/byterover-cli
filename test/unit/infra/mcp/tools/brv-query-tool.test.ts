import type {ConnectionState, ConnectionStateHandler, ITransportClient} from '@campfirein/brv-transport-client'
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'

import {expect} from 'chai'
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {restore, type SinonFakeTimers, type SinonStub, stub, useFakeTimers} from 'sinon'

import type {QueryToolModeResult} from '../../../../../src/server/core/interfaces/executor/i-query-executor.js'
import type {McpStartupProjectContext} from '../../../../../src/server/infra/mcp/tools/mcp-project-context.js'

import {BrvQueryInputSchema, registerBrvQueryTool} from '../../../../../src/server/infra/mcp/tools/brv-query-tool.js'
import {decodeQueryToolModeContent} from '../../../../../src/shared/transport/query-tool-mode-content.js'

/** Returns undefined — named constant avoids inline `() => undefined` triggering unicorn/no-useless-undefined. */
const noClient = (): ITransportClient | undefined => undefined
const noWorkingDirectory = (): string | undefined => undefined

/**
 * Handler type captured from server.registerTool().
 */
type QueryToolHandler = (input: {cwd?: string; limit?: number; query: string}) => Promise<{
  content: Array<{text: string; type: string}>
  isError?: boolean
}>

/**
 * Creates a mock McpServer that captures tool handlers on registerTool().
 */
function createMockMcpServer(): {
  getHandler: (name: string) => QueryToolHandler
  server: McpServer
} {
  const handlers = new Map<string, QueryToolHandler>()

  const mock = {
    registerTool(name: string, _config: unknown, cb: QueryToolHandler) {
      handlers.set(name, cb)
    },
  }

  return {
    getHandler(name: string): QueryToolHandler {
      const handler = handlers.get(name)
      if (!handler) throw new Error(`Handler ${name} not registered`)
      return handler
    },
    server: mock as unknown as McpServer,
  }
}

/**
 * Creates a mock transport client for testing.
 */
function createMockClient(options?: {state?: ConnectionState}): {
  client: ITransportClient
  simulateEvent: <T>(event: string, payload: T) => void
  simulateStateChange: (state: ConnectionState) => void
} {
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>()
  const stateHandlers = new Set<ConnectionStateHandler>()

  const client: ITransportClient = {
    connect: stub().resolves(),
    disconnect: stub().resolves(),
    getClientId: stub().returns('mock-client-id'),
    getDaemonVersion: stub(),
    getState: stub().returns(options?.state ?? 'connected'),
    isConnected: stub().resolves(true),
    joinRoom: stub().resolves(),
    leaveRoom: stub().resolves(),
    on<T>(event: string, handler: (data: T) => void) {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, new Set())
      }

      eventHandlers.get(event)!.add(handler as (data: unknown) => void)
      return () => {
        eventHandlers.get(event)?.delete(handler as (data: unknown) => void)
      }
    },
    once: stub(),
    onStateChange(handler: ConnectionStateHandler) {
      stateHandlers.add(handler)
      return () => {
        stateHandlers.delete(handler)
      }
    },
    request: stub() as unknown as ITransportClient['request'],
    requestWithAck: stub().resolves(),
  }

  return {
    client,
    simulateEvent<T>(event: string, payload: T) {
      const handlers = eventHandlers.get(event)
      if (handlers) {
        for (const handler of handlers) {
          handler(payload)
        }
      }
    },
    simulateStateChange(state: ConnectionState) {
      for (const handler of stateHandlers) {
        handler(state)
      }
    },
  }
}

/**
 * Registers the brv-query tool on a mock McpServer and returns the captured handler.
 */
function setupQueryHandler(options: {
  getClient: () => ITransportClient | undefined
  getStartupProjectContext?: () => McpStartupProjectContext | undefined
  getWorkingDirectory: () => string | undefined
}): QueryToolHandler {
  const {getHandler, server} = createMockMcpServer()
  registerBrvQueryTool(
    server,
    options.getClient,
    options.getWorkingDirectory,
    options.getStartupProjectContext ??
      (() => {
        const workingDirectory = options.getWorkingDirectory()
        return workingDirectory ? {projectRoot: workingDirectory, worktreeRoot: workingDirectory} : undefined
      }),
    'test-client-version',
  )
  return getHandler('brv-query')
}

/**
 * Build a `QueryToolModeResult` envelope for the mock daemon to return
 * via `task:completed`. Defaults model a single-match ok envelope; pass
 * overrides for specific shapes.
 */
function makeEnvelope(overrides: Partial<QueryToolModeResult> = {}): QueryToolModeResult {
  return {
    matchedDocs: [
      {
        format: 'html',
        path: 'security/auth.html',
        // eslint-disable-next-line camelcase
        rendered_md: '# Auth\n\nAuth is implemented with JWT.',
        score: 0.91,
        title: 'JWT authentication',
      },
    ],
    metadata: {
      cacheHit: null,
      durationMs: 142,
      skippedSharedCount: 0,
      tier: 2,
      topScore: 0.91,
      totalFound: 1,
    },
    status: 'ok',
    ...overrides,
  }
}

describe('brv-query-tool', () => {
  afterEach(() => {
    restore()
  })

  describe('BrvQueryInputSchema', () => {
    it('accepts query without cwd', () => {
      const result = BrvQueryInputSchema.safeParse({query: 'How is auth implemented?'})
      expect(result.success).to.be.true
    })

    it('accepts query with cwd and limit', () => {
      const result = BrvQueryInputSchema.safeParse({
        cwd: '/path/to/project',
        limit: 5,
        query: 'How is auth implemented?',
      })
      expect(result.success).to.be.true
    })

    it('rejects missing query', () => {
      const result = BrvQueryInputSchema.safeParse({cwd: '/path'})
      expect(result.success).to.be.false
    })

    it('rejects limit below 1', () => {
      const result = BrvQueryInputSchema.safeParse({limit: 0, query: 'q'})
      expect(result.success).to.be.false
    })

    it('rejects limit above 50', () => {
      const result = BrvQueryInputSchema.safeParse({limit: 51, query: 'q'})
      expect(result.success).to.be.false
    })

    it('rejects non-integer limit', () => {
      const result = BrvQueryInputSchema.safeParse({limit: 3.5, query: 'q'})
      expect(result.success).to.be.false
    })

    it('exposes cwd, limit, and query in the schema shape', () => {
      const {shape} = BrvQueryInputSchema
      expect(shape).to.have.property('cwd')
      expect(shape).to.have.property('limit')
      expect(shape).to.have.property('query')
    })
  })

  describe('dispatch — task type + payload', () => {
    it('submits task type "query-tool-mode" with JSON-encoded content', async () => {
      const {client, simulateEvent} = createMockClient()
      const requestStub = client.requestWithAck as SinonStub
      requestStub.callsFake((event: string, data: {taskId?: string}) => {
        if (event === 'task:create' && data.taskId) {
          simulateEvent('task:completed', {result: JSON.stringify(makeEnvelope()), taskId: data.taskId})
        }

        return Promise.resolve()
      })

      const handler = setupQueryHandler({
        getClient: () => client,
        getWorkingDirectory: () => '/project/root',
      })

      const result = await handler({limit: 3, query: 'How does auth work?'})

      expect(result.isError).to.be.undefined

      const createCall = requestStub.getCalls().find((c: {args: unknown[]}) => c.args[0] === 'task:create')
      expect(createCall, 'task:create dispatched').to.exist
      const payload = createCall!.args[1] as {content: string; type: string}
      expect(payload.type).to.equal('query-tool-mode')

      const decoded = decodeQueryToolModeContent(payload.content)
      expect(decoded.query).to.equal('How does auth work?')
      expect(decoded.limit).to.equal(3)
    })

    it('omits limit when input does not include one (daemon applies default)', async () => {
      const {client, simulateEvent} = createMockClient()
      const requestStub = client.requestWithAck as SinonStub
      requestStub.callsFake((event: string, data: {taskId?: string}) => {
        if (event === 'task:create' && data.taskId) {
          simulateEvent('task:completed', {result: JSON.stringify(makeEnvelope()), taskId: data.taskId})
        }

        return Promise.resolve()
      })

      const handler = setupQueryHandler({
        getClient: () => client,
        getWorkingDirectory: () => '/project/root',
      })

      await handler({query: 'q'})

      const createCall = requestStub.getCalls().find((c: {args: unknown[]}) => c.args[0] === 'task:create')
      const decoded = decodeQueryToolModeContent((createCall!.args[1] as {content: string}).content)
      expect(decoded.limit).to.be.undefined
    })
  })

  describe('envelope rendering — status: ok', () => {
    it('renders a single match as a markdown section with title heading', async () => {
      const {client, simulateEvent} = createMockClient()
      const requestStub = client.requestWithAck as SinonStub
      requestStub.callsFake((_event: string, data: {taskId: string}) => {
        simulateEvent('task:completed', {result: JSON.stringify(makeEnvelope()), taskId: data.taskId})
        return Promise.resolve()
      })

      const handler = setupQueryHandler({
        getClient: () => client,
        getWorkingDirectory: () => '/project/root',
      })

      const result = await handler({query: 'auth'})

      expect(result.isError).to.be.undefined
      expect(result.content[0].text).to.include('## JWT authentication')
      expect(result.content[0].text).to.include('Auth is implemented with JWT.')
      expect(result.content[0].text).to.include('_Matched 1 topic(s) in 142ms (tier 2)._')
    })

    it('falls back to the path when title is missing', async () => {
      const {client, simulateEvent} = createMockClient()
      const requestStub = client.requestWithAck as SinonStub
      requestStub.callsFake((_event: string, data: {taskId: string}) => {
        const env = makeEnvelope({
          matchedDocs: [
            {
              format: 'markdown',
              path: 'legacy/notes.md',
              // eslint-disable-next-line camelcase
              rendered_md: '# notes',
              score: 0.6,
              title: '',
            },
          ],
        })
        simulateEvent('task:completed', {result: JSON.stringify(env), taskId: data.taskId})
        return Promise.resolve()
      })

      const handler = setupQueryHandler({
        getClient: () => client,
        getWorkingDirectory: () => '/project/root',
      })

      const result = await handler({query: 'q'})

      expect(result.content[0].text).to.include('## legacy/notes.md')
    })

    it('separates multiple matches with `---` and emits one trailer line', async () => {
      const {client, simulateEvent} = createMockClient()
      const requestStub = client.requestWithAck as SinonStub
      requestStub.callsFake((_event: string, data: {taskId: string}) => {
        const env = makeEnvelope({
          matchedDocs: [
            {
              format: 'html',
              path: 'a.html',
              // eslint-disable-next-line camelcase
              rendered_md: 'body A',
              score: 0.9,
              title: 'Topic A',
            },
            {
              format: 'html',
              path: 'b.html',
              // eslint-disable-next-line camelcase
              rendered_md: 'body B',
              score: 0.7,
              title: 'Topic B',
            },
          ],
          metadata: {
            cacheHit: null,
            durationMs: 60,
            skippedSharedCount: 0,
            tier: 2,
            topScore: 0.9,
            totalFound: 2,
          },
        })
        simulateEvent('task:completed', {result: JSON.stringify(env), taskId: data.taskId})
        return Promise.resolve()
      })

      const handler = setupQueryHandler({
        getClient: () => client,
        getWorkingDirectory: () => '/project/root',
      })

      const result = await handler({query: 'q'})

      const {text} = result.content[0]
      expect(text).to.include('## Topic A')
      expect(text).to.include('## Topic B')
      expect(text).to.include('\n\n---\n\n')
      expect(text.match(/_Matched/g) ?? []).to.have.length(1)
      expect(text).to.include('_Matched 2 topic(s) in 60ms (tier 2)._')
    })
  })

  describe('envelope rendering — status: no-matches', () => {
    it('returns a short text block citing the query, not an error', async () => {
      const {client, simulateEvent} = createMockClient()
      const requestStub = client.requestWithAck as SinonStub
      requestStub.callsFake((_event: string, data: {taskId: string}) => {
        const env: QueryToolModeResult = {
          matchedDocs: [],
          metadata: {
            cacheHit: null,
            durationMs: 12,
            skippedSharedCount: 0,
            tier: 2,
            topScore: 0,
            totalFound: 0,
          },
          status: 'no-matches',
        }
        simulateEvent('task:completed', {result: JSON.stringify(env), taskId: data.taskId})
        return Promise.resolve()
      })

      const handler = setupQueryHandler({
        getClient: () => client,
        getWorkingDirectory: () => '/project/root',
      })

      const result = await handler({query: 'quantum cryptography'})

      expect(result.isError).to.be.undefined
      expect(result.content[0].text).to.include('No topics matched "quantum cryptography"')
    })
  })

  describe('envelope rendering — malformed payload', () => {
    it('returns a clear actionable error when the daemon result is not valid JSON', async () => {
      const {client, simulateEvent} = createMockClient()
      const requestStub = client.requestWithAck as SinonStub
      requestStub.callsFake((_event: string, data: {taskId: string}) => {
        simulateEvent('task:completed', {result: 'not-json{', taskId: data.taskId})
        return Promise.resolve()
      })

      const handler = setupQueryHandler({
        getClient: () => client,
        getWorkingDirectory: () => '/project/root',
      })

      const result = await handler({query: 'q'})

      expect(result.isError).to.be.true
      expect(result.content[0].text).to.include('Rebuild byterover-cli')
    })
  })

  describe('handler — project mode', () => {
    it('uses projectRoot as clientCwd when cwd is not provided', async () => {
      const {client, simulateEvent} = createMockClient()
      const requestStub = client.requestWithAck as SinonStub
      requestStub.callsFake((_event: string, data: {taskId: string}) => {
        simulateEvent('task:completed', {result: JSON.stringify(makeEnvelope()), taskId: data.taskId})
        return Promise.resolve()
      })

      const handler = setupQueryHandler({
        getClient: () => client,
        getWorkingDirectory: () => '/project/root',
      })

      const result = await handler({query: 'q'})

      expect(result.isError).to.be.undefined
      const payload = requestStub.firstCall.args[1]
      expect(payload.clientCwd).to.equal('/project/root')
      expect(payload.taskId).to.be.a('string')
    })

    it('prefers explicit cwd over projectRoot', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'brv-query-project-'))
      const otherProject = mkdtempSync(join(tmpdir(), 'brv-query-other-'))
      mkdirSync(join(projectRoot, '.brv'), {recursive: true})
      mkdirSync(join(otherProject, '.brv'), {recursive: true})
      writeFileSync(join(projectRoot, '.brv', 'config.json'), '{}')
      writeFileSync(join(otherProject, '.brv', 'config.json'), '{}')
      const canonicalOtherProject = realpathSync(otherProject)

      try {
        const {client, simulateEvent} = createMockClient()
        const requestStub = client.requestWithAck as SinonStub
        requestStub.callsFake((_event: string, data: {taskId: string}) => {
          simulateEvent('task:completed', {result: JSON.stringify(makeEnvelope()), taskId: data.taskId})
          return Promise.resolve()
        })

        const handler = setupQueryHandler({
          getClient: () => client,
          getWorkingDirectory: () => projectRoot,
        })

        await handler({cwd: otherProject, query: 'test'})

        const payload = requestStub.firstCall.args[1]
        expect(payload.clientCwd).to.equal(otherProject)
        expect(payload.projectPath).to.equal(canonicalOtherProject)
      } finally {
        rmSync(projectRoot, {force: true, recursive: true})
        rmSync(otherProject, {force: true, recursive: true})
      }
    })
  })

  describe('handler — global mode', () => {
    it('returns error when cwd is not provided and no working directory', async () => {
      const handler = setupQueryHandler({
        getClient: () => createMockClient().client,
        getWorkingDirectory: noWorkingDirectory,
      })

      const result = await handler({query: 'test'})

      expect(result.isError).to.be.true
      expect(result.content[0].text).to.include('cwd parameter is required')
      expect(result.content[0].text).to.include('global mode')
    })

    it('uses explicit cwd when provided in global mode', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'brv-query-global-'))
      mkdirSync(join(projectRoot, '.brv'), {recursive: true})
      writeFileSync(join(projectRoot, '.brv', 'config.json'), '{}')
      const canonicalProjectRoot = realpathSync(projectRoot)

      try {
        const {client, simulateEvent} = createMockClient()
        const requestStub = client.requestWithAck as SinonStub
        requestStub.callsFake((event: string, data: {taskId?: string}) => {
          if (event === 'task:create' && data.taskId) {
            simulateEvent('task:completed', {result: JSON.stringify(makeEnvelope()), taskId: data.taskId})
          }

          return Promise.resolve()
        })

        const handler = setupQueryHandler({
          getClient: () => client,
          getWorkingDirectory: noWorkingDirectory,
        })

        const result = await handler({cwd: projectRoot, query: 'test'})

        expect(result.isError).to.be.undefined
        const createCall = requestStub.getCalls().find((c: {args: unknown[]}) => c.args[0] === 'task:create')
        expect(createCall).to.exist
        expect(createCall!.args[1]).to.have.property('clientCwd', projectRoot)
        expect(createCall!.args[1]).to.have.property('projectPath', canonicalProjectRoot)
        expect(createCall!.args[1]).to.have.property('worktreeRoot', canonicalProjectRoot)
      } finally {
        rmSync(projectRoot, {force: true, recursive: true})
      }
    })

    it('calls client:associateProject with walked-up project root in global mode', async () => {
      const rawProjectRoot = mkdtempSync(join(tmpdir(), 'brv-test-'))
      const projectRoot = realpathSync(rawProjectRoot)
      const subDir = join(projectRoot, 'src', 'modules')
      mkdirSync(join(projectRoot, '.brv'), {recursive: true})
      writeFileSync(join(projectRoot, '.brv', 'config.json'), '{}')
      mkdirSync(subDir, {recursive: true})

      try {
        const {client, simulateEvent} = createMockClient()
        const requestStub = client.requestWithAck as SinonStub
        requestStub.callsFake((event: string, data: {taskId?: string}) => {
          if (event === 'task:create' && data.taskId) {
            simulateEvent('task:completed', {result: JSON.stringify(makeEnvelope()), taskId: data.taskId})
          }

          return Promise.resolve()
        })

        const handler = setupQueryHandler({
          getClient: () => client,
          getWorkingDirectory: noWorkingDirectory,
        })

        await handler({cwd: subDir, query: 'test'})

        const associateCall = requestStub
          .getCalls()
          .find((c: {args: unknown[]}) => c.args[0] === 'client:associateProject')
        expect(associateCall).to.exist
        expect(associateCall!.args[1]).to.deep.equal({projectPath: projectRoot})
      } finally {
        rmSync(projectRoot, {force: true, recursive: true})
      }
    })

    it('does not call client:associateProject in project mode', async () => {
      const {client, simulateEvent} = createMockClient()
      const requestStub = client.requestWithAck as SinonStub
      requestStub.callsFake((_event: string, data: {taskId?: string}) => {
        if (data.taskId) {
          simulateEvent('task:completed', {result: JSON.stringify(makeEnvelope()), taskId: data.taskId})
        }

        return Promise.resolve()
      })

      const handler = setupQueryHandler({
        getClient: () => client,
        getWorkingDirectory: () => '/project/root',
      })

      await handler({query: 'test'})

      const associateCall = requestStub
        .getCalls()
        .find((c: {args: unknown[]}) => c.args[0] === 'client:associateProject')
      expect(associateCall).to.be.undefined
    })
  })

  describe('handler — client errors', () => {
    let clock: SinonFakeTimers

    beforeEach(() => {
      clock = useFakeTimers()
    })

    afterEach(() => {
      clock.restore()
    })

    it('returns error after timeout when client is undefined', async () => {
      const handler = setupQueryHandler({
        getClient: noClient,
        getWorkingDirectory: () => '/project/root',
      })

      const resultPromise = handler({query: 'test'})
      await clock.tickAsync(61_000)
      const result = await resultPromise

      expect(result.isError).to.be.true
      expect(result.content[0].text).to.include('Not connected')
      expect(result.content[0].text).to.include('timed out')
    })

    it('returns error after timeout when client is disconnected', async () => {
      const {client} = createMockClient({state: 'disconnected'})

      const handler = setupQueryHandler({
        getClient: () => client,
        getWorkingDirectory: () => '/project/root',
      })

      const resultPromise = handler({query: 'test'})
      await clock.tickAsync(61_000)
      const result = await resultPromise

      expect(result.isError).to.be.true
      expect(result.content[0].text).to.include('Not connected')
      expect(result.content[0].text).to.include('timed out')
    })

    it('resolves immediately when client becomes connected during wait', async () => {
      const {client, simulateEvent} = createMockClient({state: 'reconnecting'})
      const currentClient = client

      const handler = setupQueryHandler({
        getClient: () => currentClient,
        getWorkingDirectory: () => '/project/root',
      })

      const requestStub = client.requestWithAck as SinonStub
      requestStub.callsFake((_event: string, data: {taskId: string}) => {
        simulateEvent('task:completed', {result: JSON.stringify(makeEnvelope()), taskId: data.taskId})
        return Promise.resolve()
      })

      const resultPromise = handler({query: 'test'})

      await clock.tickAsync(2000)
      ;(client.getState as SinonStub).returns('connected')
      await clock.tickAsync(1000)

      const result = await resultPromise

      expect(result.isError).to.be.undefined
      expect(result.content[0].text).to.include('## JWT authentication')
    })
  })

  describe('handler — transport errors', () => {
    it('returns error when requestWithAck rejects', async () => {
      const {client} = createMockClient()
      const requestStub = client.requestWithAck as SinonStub
      requestStub.rejects(new Error('Connection refused'))

      const handler = setupQueryHandler({
        getClient: () => client,
        getWorkingDirectory: () => '/project/root',
      })

      const result = await handler({query: 'test'})

      expect(result.isError).to.be.true
      expect(result.content[0].text).to.include('Connection refused')
    })

    it('returns error when task fails with error event', async () => {
      const {client, simulateEvent} = createMockClient()
      const requestStub = client.requestWithAck as SinonStub
      requestStub.callsFake((_event: string, data: {taskId: string}) => {
        simulateEvent('task:error', {
          error: {message: 'Index unavailable', name: 'TaskError'},
          taskId: data.taskId,
        })
        return Promise.resolve()
      })

      const handler = setupQueryHandler({
        getClient: () => client,
        getWorkingDirectory: () => '/project/root',
      })

      const result = await handler({query: 'test'})

      expect(result.isError).to.be.true
      expect(result.content[0].text).to.include('Index unavailable')
    })
  })

  describe('handler — event listener ordering', () => {
    it('registers event listeners before sending task:create (race condition prevention)', async () => {
      const {client, simulateEvent} = createMockClient()
      let listenersRegisteredBeforeCreate = false

      const requestStub = client.requestWithAck as SinonStub
      requestStub.callsFake((_event: string, data: {taskId: string}) => {
        listenersRegisteredBeforeCreate = true
        simulateEvent('task:completed', {result: JSON.stringify(makeEnvelope()), taskId: data.taskId})
        return Promise.resolve()
      })

      const handler = setupQueryHandler({
        getClient: () => client,
        getWorkingDirectory: () => '/project/root',
      })

      const result = await handler({query: 'test'})

      expect(listenersRegisteredBeforeCreate).to.be.true
      expect(result.isError).to.be.undefined
    })
  })
})

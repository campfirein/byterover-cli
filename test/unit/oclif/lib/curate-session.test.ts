/**
 * curate-session orchestrator tests.
 *
 * The orchestrator owns the multi-step session protocol — kickoff
 * (in-process), continuation (dispatches `curate-tool-mode` to the
 * daemon and maps the result back to the wire envelope), retry-cap loop
 * on validation failures, and SESSION_ID path-traversal guards.
 *
 * The write itself (HTML validation, file write, log persistence,
 * review backup, sidecar bump, index regen) lives in the daemon's
 * `case 'curate-tool-mode'` handler — those behaviors are covered by
 * daemon-side tests + the integration test that exercises a real
 * daemon round-trip. Here we mock the transport client so the unit
 * tests stay fast and focus on orchestrator concerns.
 */

import type {ConnectionState, ConnectionStateHandler, ITransportClient} from '@campfirein/brv-transport-client'

import {expect} from 'chai'
import {existsSync} from 'node:fs'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {type SinonStub, stub} from 'sinon'

import type {CurateHtmlDirectResult} from '../../../../src/server/core/interfaces/executor/i-curate-executor.js'
import type {HtmlWriteError} from '../../../../src/server/infra/render/writer/html-writer.js'
import type {CurateMeta} from '../../../../src/shared/curate-meta.js'

import {
  continueSession,
  CURATE_SESSION_PREFIX,
  CURATE_SESSIONS_DIR,
  deleteCurateResponseFile,
  InvalidResponseFileError,
  InvalidResponseFormatError,
  kickoffSession,
  loadCurateResponseFile,
  parseCurateResponse,
  peekCurateSession,
  resolveProjectRoot,
  unknownSessionEnvelope,
} from '../../../../src/oclif/lib/curate-session.js'
import {BRV_DIR} from '../../../../src/server/constants.js'
import {decodeCurateHtmlContent} from '../../../../src/shared/transport/curate-html-content.js'

const VALID_TOPIC_HTML_RAW = '<bv-topic path="security/auth" title="JWT auth"><bv-reason>x</bv-reason></bv-topic>'
const TOPIC_WITHOUT_PATH_RAW = '<bv-topic title="JWT auth"></bv-topic>'

/** Build the JSON envelope shape expected by the continuation protocol. */
function envelope(html: string, meta?: CurateMeta): string {
  return meta === undefined ? JSON.stringify({html}) : JSON.stringify({html, meta})
}

const VALID_TOPIC_HTML = envelope(VALID_TOPIC_HTML_RAW)
const TOPIC_WITHOUT_PATH = envelope(TOPIC_WITHOUT_PATH_RAW)

const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

function assertDefined<T>(value: T | undefined, label: string): asserts value is T {
  if (value === undefined) throw new Error(`expected ${label} to be defined`)
}

/**
 * Mock daemon transport client. The orchestrator only uses
 * `requestWithAck` (to dispatch `task:create`) and `on` (to subscribe
 * to lifecycle events). We capture the dispatch payload and let the
 * caller simulate `task:completed` with a chosen `CurateHtmlDirectResult`.
 */
function createMockClient(): {
  client: ITransportClient
  getDispatched: () => undefined | {content: string; projectPath?: string; taskId: string; type: string}
  simulateEvent: <T>(event: string, payload: T) => void
} {
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>()
  const stateHandlers = new Set<ConnectionStateHandler>()

  const client: ITransportClient = {
    connect: stub().resolves(),
    disconnect: stub().resolves(),
    getClientId: stub().returns('mock-client-id'),
    getDaemonVersion: stub(),
    getState: stub().returns('connected' as ConnectionState),
    isConnected: stub().resolves(true),
    joinRoom: stub().resolves(),
    leaveRoom: stub().resolves(),
    on<T>(event: string, handler: (data: T) => void) {
      if (!eventHandlers.has(event)) eventHandlers.set(event, new Set())
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
    requestWithAck: stub() as unknown as ITransportClient['requestWithAck'],
  }

  return {
    client,
    getDispatched: () =>
      (
        client.requestWithAck as unknown as {
          dispatched?: {content: string; projectPath?: string; taskId: string; type: string}
        }
      ).dispatched,
    simulateEvent<T>(event: string, payload: T) {
      const handlers = eventHandlers.get(event)
      if (handlers) for (const h of handlers) h(payload)
    },
  }
}

/**
 * Wire the mock client so any `task:create` dispatch captures the
 * payload (visible via the mock's `getDispatched()`) and immediately
 * resolves with the supplied envelope. Extends the underlying stub
 * rather than replacing it so the dispatch-capture set up by
 * `createMockClient` is preserved.
 */
function respondWith(args: {
  client: ITransportClient
  envelope: CurateHtmlDirectResult
  simulateEvent: <T>(event: string, payload: T) => void
}): void {
  const {client, envelope, simulateEvent} = args
  const requestStub = client.requestWithAck as SinonStub
  requestStub.callsFake(
    async (event: string, data: {content: string; projectPath?: string; taskId: string; type: string}) => {
      if (event === 'task:create') {
        // Stash the dispatch payload on the stub so getDispatched() (set up
        // by createMockClient via a shared closure) can read it.
        ;(requestStub as unknown as {dispatched?: unknown}).dispatched = {
          content: data.content,
          projectPath: data.projectPath,
          taskId: data.taskId,
          type: data.type,
        }
        // Defer the completion to the next microtask — mirrors the real
        // daemon path where requestWithAck resolves before task:completed
        // fires. Without the defer, the simulated event would fire before
        // waitForTaskCompletion has subscribed.
        queueMicrotask(() => {
          simulateEvent('task:completed', {result: JSON.stringify(envelope), taskId: data.taskId})
        })
      }

      return {taskId: data.taskId}
    },
  )
}

function okEnvelope(overrides: Partial<Extract<CurateHtmlDirectResult, {status: 'ok'}>> = {}): CurateHtmlDirectResult {
  return {
    filePath: 'security/auth.html',
    overwrote: false,
    status: 'ok',
    topicPath: 'security/auth',
    ...overrides,
  }
}

function failureEnvelope(errors: HtmlWriteError[]): CurateHtmlDirectResult {
  return {errors, status: 'validation-failed'}
}

describe('curate-session', () => {
  let projectRoot: string

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'curate-session-'))
  })

  afterEach(async () => {
    await rm(projectRoot, {force: true, recursive: true})
  })

  // ─── kickoff (in-process; no daemon dispatch) ────────────────────────────────

  describe('kickoffSession', () => {
    it('returns needs-llm-step with a fresh uuid sessionId', async () => {
      const env = await kickoffSession({content: 'remember we use RS256', projectRoot})

      expect(env.ok).to.equal(true)
      expect(env.status).to.equal('needs-llm-step')
      expect(env.step).to.equal('generate-html')
      expect(env.sessionId).to.be.a('string')
      expect(env.sessionId!).to.match(UUID_RE)
    })

    it('includes a stub prompt that embeds the user intent verbatim', async () => {
      const intent = 'remember the JWT signing rotation policy'
      const env = await kickoffSession({content: intent, projectRoot})

      expect(env.prompt).to.be.a('string')
      expect(env.prompt!).to.include(intent)
    })

    it('writes on-disk state at the documented path with the initial schema', async () => {
      const env = await kickoffSession({content: 'x', projectRoot})
      const statePath = join(
        projectRoot,
        BRV_DIR,
        CURATE_SESSIONS_DIR,
        `${CURATE_SESSION_PREFIX}${env.sessionId!}`,
        'state.json',
      )

      expect(existsSync(statePath)).to.equal(true)
      const state = JSON.parse(await readFile(statePath, 'utf8'))
      expect(state.userIntent).to.equal('x')
      expect(state.step).to.equal('awaiting-generate')
      expect(state.attempts).to.equal(0)
      expect(state.lastResponse).to.equal('')
    })

    it('two kickoffs against the same project return distinct sessionIds', async () => {
      const a = await kickoffSession({content: 'a', projectRoot})
      const b = await kickoffSession({content: 'b', projectRoot})
      expect(a.sessionId).to.not.equal(b.sessionId)
    })
  })

  // ─── continueSession — dispatch to daemon ────────────────────────────────────

  describe('continueSession — daemon dispatch', () => {
    it('dispatches task:create with type=curate-tool-mode and the encoded envelope', async () => {
      const kickoff = await kickoffSession({content: 'remember JWT', projectRoot})
      const {client, getDispatched, simulateEvent} = createMockClient()
      respondWith({client, envelope: okEnvelope(), simulateEvent})

      await continueSession({
        client,
        projectRoot,
        response: VALID_TOPIC_HTML,
        sessionId: kickoff.sessionId!,
      })

      const dispatch = getDispatched()
      assertDefined(dispatch, 'task:create dispatch')
      expect(dispatch.type).to.equal('curate-tool-mode')
      const decoded = decodeCurateHtmlContent(dispatch.content)
      expect(decoded.html).to.equal(VALID_TOPIC_HTML_RAW)
      // continueSession defaults confirmOverwrite to false when omitted; the
      // payload always carries a boolean so the daemon doesn't have to guess.
      expect(decoded.confirmOverwrite).to.equal(false)
    })

    it('threads projectPath onto the task:create payload (mirrors MCP, removes ambient-state dependency)', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const {client, getDispatched, simulateEvent} = createMockClient()
      respondWith({client, envelope: okEnvelope(), simulateEvent})

      await continueSession({client, projectRoot, response: VALID_TOPIC_HTML, sessionId: kickoff.sessionId!})

      const dispatch = getDispatched()
      assertDefined(dispatch, 'task:create dispatch')
      expect(dispatch.projectPath).to.equal(projectRoot)
    })

    it('threads userIntent from the session state into the encoded payload', async () => {
      const intent = 'remember the JWT signing rotation policy'
      const kickoff = await kickoffSession({content: intent, projectRoot})
      const {client, getDispatched, simulateEvent} = createMockClient()
      respondWith({client, envelope: okEnvelope(), simulateEvent})

      await continueSession({client, projectRoot, response: VALID_TOPIC_HTML, sessionId: kickoff.sessionId!})

      const dispatch = getDispatched()
      assertDefined(dispatch, 'task:create dispatch')
      const decoded = decodeCurateHtmlContent(dispatch.content)
      expect(decoded.userIntent).to.equal(intent)
    })

    it('threads meta from the response envelope into the encoded payload', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const {client, getDispatched, simulateEvent} = createMockClient()
      respondWith({client, envelope: okEnvelope(), simulateEvent})

      await continueSession({
        client,
        projectRoot,
        response: envelope(VALID_TOPIC_HTML_RAW, {impact: 'high', reason: 'r', summary: 's', type: 'ADD'}),
        sessionId: kickoff.sessionId!,
      })

      const dispatch = getDispatched()
      assertDefined(dispatch, 'task:create dispatch')
      const decoded = decodeCurateHtmlContent(dispatch.content)
      expect(decoded.meta).to.deep.equal({impact: 'high', reason: 'r', summary: 's', type: 'ADD'})
    })

    it('threads confirmOverwrite into the encoded payload when set', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const {client, getDispatched, simulateEvent} = createMockClient()
      respondWith({client, envelope: okEnvelope({overwrote: true}), simulateEvent})

      await continueSession({
        client,
        confirmOverwrite: true,
        projectRoot,
        response: VALID_TOPIC_HTML,
        sessionId: kickoff.sessionId!,
      })

      const dispatch = getDispatched()
      assertDefined(dispatch, 'task:create dispatch')
      expect(decodeCurateHtmlContent(dispatch.content).confirmOverwrite).to.equal(true)
    })

    it('does not dispatch when the response envelope is unparseable', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const {client, getDispatched, simulateEvent} = createMockClient()
      respondWith({client, envelope: okEnvelope(), simulateEvent})

      const result = await continueSession({
        client,
        projectRoot,
        response: 'not-json{',
        sessionId: kickoff.sessionId!,
      })

      expect(result.status).to.equal('failed')
      expect(result.errors![0].kind).to.equal('invalid-response-format')
      expect(getDispatched(), 'no daemon dispatch on protocol-level failure').to.be.undefined
    })

    it('does not dispatch when the sessionId is unknown', async () => {
      const {client, getDispatched, simulateEvent} = createMockClient()
      respondWith({client, envelope: okEnvelope(), simulateEvent})

      await continueSession({
        client,
        projectRoot,
        response: VALID_TOPIC_HTML,
        sessionId: '00000000-0000-0000-0000-000000000000',
      })

      expect(getDispatched(), 'no daemon dispatch on unknown-session').to.be.undefined
    })
  })

  // ─── continueSession — response mapping ──────────────────────────────────────

  describe('continueSession — happy path mapping', () => {
    it('maps daemon ok envelope to status=done with the relative filePath', async () => {
      const kickoff = await kickoffSession({content: 'remember JWT', projectRoot})
      const {client, simulateEvent} = createMockClient()
      respondWith({client, envelope: okEnvelope({filePath: 'security/auth.html'}), simulateEvent})

      const env = await continueSession({client, projectRoot, response: VALID_TOPIC_HTML, sessionId: kickoff.sessionId!})

      expect(env.ok).to.equal(true)
      expect(env.status).to.equal('done')
      expect(env.filePath).to.equal('security/auth.html')
      // Session cleared on success.
      const stateDir = join(projectRoot, BRV_DIR, CURATE_SESSIONS_DIR, `${CURATE_SESSION_PREFIX}${kickoff.sessionId!}`)
      expect(existsSync(stateDir)).to.equal(false)
    })

    it('surfaces warnings on the done envelope when the daemon supplies them', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const {client, simulateEvent} = createMockClient()
      respondWith({
        client,
        envelope: okEnvelope({warnings: ['related ref @security/missing did not resolve']}),
        simulateEvent,
      })

      const env = await continueSession({client, projectRoot, response: VALID_TOPIC_HTML, sessionId: kickoff.sessionId!})

      expect(env.status).to.equal('done')
      assertDefined(env.warnings, 'env.warnings')
      expect(env.warnings).to.have.lengthOf(1)
      expect(env.warnings[0]).to.include('@security/missing')
    })

    it('omits the warnings field on a clean done envelope (no warnings from the daemon)', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const {client, simulateEvent} = createMockClient()
      respondWith({client, envelope: okEnvelope(), simulateEvent})

      const env = await continueSession({client, projectRoot, response: VALID_TOPIC_HTML, sessionId: kickoff.sessionId!})

      expect(env.status).to.equal('done')
      expect(env.warnings, 'warnings omitted on clean writes').to.equal(undefined)
    })

    it('second continuation against a completed sessionId returns unknown-session', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const sessionId = kickoff.sessionId!
      const {client, simulateEvent} = createMockClient()
      respondWith({client, envelope: okEnvelope(), simulateEvent})

      // First continuation succeeds and clears state.
      await continueSession({client, projectRoot, response: VALID_TOPIC_HTML, sessionId})

      // Second continuation: state.json no longer exists → unknown-session.
      const env = await continueSession({client, projectRoot, response: VALID_TOPIC_HTML, sessionId})
      expect(env.status).to.equal('failed')
      expect(env.errors![0].kind).to.equal('unknown-session')
    })
  })

  describe('continueSession — validation-failed mapping', () => {
    it('maps daemon validation-failed to needs-llm-step/correct-html with structured errors', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const sessionId = kickoff.sessionId!
      const {client, simulateEvent} = createMockClient()
      respondWith({
        client,
        envelope: failureEnvelope([{kind: 'missing-path-attribute', message: 'topic missing path attr'}]),
        simulateEvent,
      })

      const env = await continueSession({client, projectRoot, response: TOPIC_WITHOUT_PATH, sessionId})

      expect(env.ok).to.equal(false)
      expect(env.status).to.equal('needs-llm-step')
      expect(env.step).to.equal('correct-html')
      expect(env.sessionId).to.equal(sessionId)
      assertDefined(env.errors, 'env.errors')
      expect(env.errors.some((e) => e.kind === 'missing-path-attribute')).to.equal(true)

      // Session stays on disk for the retry.
      const stateDir = join(projectRoot, BRV_DIR, CURATE_SESSIONS_DIR, `${CURATE_SESSION_PREFIX}${sessionId}`)
      expect(existsSync(stateDir)).to.equal(true)
      const state = JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8'))
      expect(state.step).to.equal('awaiting-correct')
      expect(state.attempts).to.equal(1)
      expect(state.lastResponse).to.equal(TOPIC_WITHOUT_PATH)
    })

    it('correction prompt embeds the previous response so the calling agent can target the fix', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const {client, simulateEvent} = createMockClient()
      respondWith({
        client,
        envelope: failureEnvelope([{kind: 'missing-path-attribute', message: 'no path'}]),
        simulateEvent,
      })

      const env = await continueSession({
        client,
        projectRoot,
        response: TOPIC_WITHOUT_PATH,
        sessionId: kickoff.sessionId!,
      })

      expect(env.prompt).to.include(TOPIC_WITHOUT_PATH)
    })

    it('maps path-exists errors with existingContent into the envelope error shape', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const {client, simulateEvent} = createMockClient()
      const existing = '<bv-topic path="security/auth" title="prior"><bv-reason>old</bv-reason></bv-topic>'
      respondWith({
        client,
        envelope: failureEnvelope([
          {existingContent: existing, kind: 'path-exists', message: 'topic exists', topicPath: 'security/auth'},
        ]),
        simulateEvent,
      })

      const env = await continueSession({
        client,
        projectRoot,
        response: VALID_TOPIC_HTML,
        sessionId: kickoff.sessionId!,
      })

      assertDefined(env.errors, 'env.errors')
      const pathExists = env.errors.find((e) => e.kind === 'path-exists')
      assertDefined(pathExists, 'path-exists error')
      expect(pathExists.existingContent).to.equal(existing)
    })

    it('maps attribute-validation errors into {tag, attribute, message}', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const {client, simulateEvent} = createMockClient()
      respondWith({
        client,
        envelope: failureEnvelope([
          {field: 'severity', kind: 'attribute-validation', message: 'invalid', tag: 'bv-rule'},
        ]),
        simulateEvent,
      })

      const env = await continueSession({client, projectRoot, response: VALID_TOPIC_HTML, sessionId: kickoff.sessionId!})
      assertDefined(env.errors, 'env.errors')
      const attr = env.errors.find((e) => e.kind === 'attribute-validation')
      assertDefined(attr, 'attribute-validation error')
      expect(attr.tag).to.equal('bv-rule')
      expect(attr.attribute).to.equal('severity')
    })

    it('maps unknown-bv-element errors to kind=unknown-element with the tag preserved', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const {client, simulateEvent} = createMockClient()
      respondWith({
        client,
        envelope: failureEnvelope([{kind: 'unknown-bv-element', message: 'no such tag', tag: 'bv-not-a-real-tag'}]),
        simulateEvent,
      })

      const env = await continueSession({client, projectRoot, response: VALID_TOPIC_HTML, sessionId: kickoff.sessionId!})
      const unknown = env.errors!.find((e) => e.kind === 'unknown-element')
      assertDefined(unknown, 'unknown-element error')
      expect(unknown.tag).to.equal('bv-not-a-real-tag')
    })
  })

  // ─── retry cap ───────────────────────────────────────────────────────────────

  describe('continueSession — retry cap', () => {
    it('terminates with retry-cap-exceeded after the 4th consecutive validation failure', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const sessionId = kickoff.sessionId!
      const {client, simulateEvent} = createMockClient()
      respondWith({
        client,
        envelope: failureEnvelope([{kind: 'missing-path-attribute', message: 'no path'}]),
        simulateEvent,
      })

      const envelopes: Array<Awaited<ReturnType<typeof continueSession>>> = []
      for (let i = 0; i < 4; i++) {
        // eslint-disable-next-line no-await-in-loop
        const env = await continueSession({client, projectRoot, response: TOPIC_WITHOUT_PATH, sessionId})
        envelopes.push(env)
      }

      // Attempts 1-3 stay live with correct-html.
      for (let i = 0; i < 3; i++) {
        expect(envelopes[i].status, `attempt ${i + 1}`).to.equal('needs-llm-step')
        expect(envelopes[i].step, `attempt ${i + 1}`).to.equal('correct-html')
      }

      // Attempt 4 terminates.
      const final = envelopes[3]
      expect(final.status).to.equal('failed')
      expect(final.errors!.some((e) => e.kind === 'retry-cap-exceeded')).to.equal(true)
      expect(final.sessionId).to.equal(undefined)

      // Session cleared on terminal failure.
      const stateDir = join(projectRoot, BRV_DIR, CURATE_SESSIONS_DIR, `${CURATE_SESSION_PREFIX}${sessionId}`)
      expect(existsSync(stateDir)).to.equal(false)
    })

    it('path-exists failures count toward the retry cap (state.attempts increments)', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const sessionId = kickoff.sessionId!
      const {client, simulateEvent} = createMockClient()
      respondWith({
        client,
        envelope: failureEnvelope([
          {existingContent: '<bv-topic />', kind: 'path-exists', message: 'exists', topicPath: 'security/auth'},
        ]),
        simulateEvent,
      })

      await continueSession({client, projectRoot, response: VALID_TOPIC_HTML, sessionId})

      const statePath = join(
        projectRoot,
        BRV_DIR,
        CURATE_SESSIONS_DIR,
        `${CURATE_SESSION_PREFIX}${sessionId}`,
        'state.json',
      )
      const state = JSON.parse(await readFile(statePath, 'utf8'))
      expect(state.attempts).to.equal(1)
      expect(state.step).to.equal('awaiting-correct')
    })

    it('a valid response after a validation failure clears the session with status=done', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const sessionId = kickoff.sessionId!

      // Invalid response → correct-html.
      const {client: client1, simulateEvent: sim1} = createMockClient()
      respondWith({
        client: client1,
        envelope: failureEnvelope([{kind: 'missing-path-attribute', message: 'no path'}]),
        simulateEvent: sim1,
      })
      await continueSession({client: client1, projectRoot, response: TOPIC_WITHOUT_PATH, sessionId})

      // Corrected response → done.
      const {client: client2, simulateEvent: sim2} = createMockClient()
      respondWith({client: client2, envelope: okEnvelope(), simulateEvent: sim2})
      const env = await continueSession({client: client2, projectRoot, response: VALID_TOPIC_HTML, sessionId})

      expect(env.status).to.equal('done')
      const stateDir = join(projectRoot, BRV_DIR, CURATE_SESSIONS_DIR, `${CURATE_SESSION_PREFIX}${sessionId}`)
      expect(existsSync(stateDir)).to.equal(false)
    })
  })

  // ─── non-HTML failures + security + robustness ───────────────────────────────

  describe('continueSession — non-HTML failures', () => {
    it('returns failed with unknown-session for an unknown sessionId', async () => {
      const {client, simulateEvent} = createMockClient()
      respondWith({client, envelope: okEnvelope(), simulateEvent})

      const env = await continueSession({
        client,
        projectRoot,
        response: VALID_TOPIC_HTML,
        sessionId: '00000000-0000-0000-0000-000000000000',
      })

      expect(env.status).to.equal('failed')
      expect(env.errors![0].kind).to.equal('unknown-session')
    })

    it('returns failed with empty-response for a whitespace payload; session stays live', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const sessionId = kickoff.sessionId!
      const {client, simulateEvent} = createMockClient()
      respondWith({client, envelope: okEnvelope(), simulateEvent})

      const env = await continueSession({client, projectRoot, response: '   ', sessionId})

      expect(env.status).to.equal('failed')
      expect(env.errors![0].kind).to.equal('empty-response')
      expect(env.sessionId).to.equal(sessionId)

      const stateDir = join(projectRoot, BRV_DIR, CURATE_SESSIONS_DIR, `${CURATE_SESSION_PREFIX}${sessionId}`)
      expect(existsSync(stateDir)).to.equal(true)
    })
  })

  describe('continueSession — security + robustness', () => {
    it('rejects path-traversal sessionId before any filesystem access', async () => {
      const {client, simulateEvent} = createMockClient()
      respondWith({client, envelope: okEnvelope(), simulateEvent})

      const traversalAttempts = [
        '../../../etc',
        '../sibling-project',
        '/absolute/path',
        '..',
        'curate-/../escape',
        '8609bc28-9a44-41a1-b52d-423213d5f59d/extra',
      ]

      for (const sessionId of traversalAttempts) {
        // eslint-disable-next-line no-await-in-loop
        const env = await continueSession({client, projectRoot, response: 'x', sessionId})
        expect(env.status, `case: ${sessionId}`).to.equal('failed')
        expect(env.errors![0].kind, `case: ${sessionId}`).to.equal('unknown-session')
      }
    })

    it('treats a corrupted state.json as no session', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const sessionId = kickoff.sessionId!

      const statePath = join(
        projectRoot,
        BRV_DIR,
        CURATE_SESSIONS_DIR,
        `${CURATE_SESSION_PREFIX}${sessionId}`,
        'state.json',
      )
      await writeFile(statePath, JSON.stringify({totally: 'wrong shape'}), 'utf8')

      const {client, simulateEvent} = createMockClient()
      respondWith({client, envelope: okEnvelope(), simulateEvent})
      const env = await continueSession({client, projectRoot, response: 'x', sessionId})
      expect(env.status).to.equal('failed')
      expect(env.errors![0].kind).to.equal('unknown-session')
    })

    it('treats unparseable state.json as no session', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const sessionId = kickoff.sessionId!
      const statePath = join(
        projectRoot,
        BRV_DIR,
        CURATE_SESSIONS_DIR,
        `${CURATE_SESSION_PREFIX}${sessionId}`,
        'state.json',
      )
      await writeFile(statePath, '{ this is not json', 'utf8')

      const {client, simulateEvent} = createMockClient()
      respondWith({client, envelope: okEnvelope(), simulateEvent})
      const env = await continueSession({client, projectRoot, response: 'x', sessionId})
      expect(env.status).to.equal('failed')
      expect(env.errors![0].kind).to.equal('unknown-session')
    })
  })

  // ─── envelope contract + helpers ─────────────────────────────────────────────

  describe('resolveProjectRoot', () => {
    it('returns the directory that contains the .brv/ marker when called from a subdirectory', async () => {
      const project = await mkdtemp(join(tmpdir(), 'curate-session-root-'))
      try {
        await mkdir(join(project, BRV_DIR), {recursive: true})
        const nested = join(project, 'src', 'agent')
        await mkdir(nested, {recursive: true})
        expect(resolveProjectRoot(nested)).to.equal(project)
      } finally {
        await rm(project, {force: true, recursive: true})
      }
    })

    it('returns the input directory itself when it contains .brv/', async () => {
      const project = await mkdtemp(join(tmpdir(), 'curate-session-root-'))
      try {
        await mkdir(join(project, BRV_DIR), {recursive: true})
        expect(resolveProjectRoot(project)).to.equal(project)
      } finally {
        await rm(project, {force: true, recursive: true})
      }
    })

    it('falls back to the start directory when no .brv/ marker is found upward', async () => {
      const project = await mkdtemp(join(tmpdir(), 'curate-session-no-brv-'))
      try {
        expect(resolveProjectRoot(project)).to.equal(project)
      } finally {
        await rm(project, {force: true, recursive: true})
      }
    })
  })

  describe('envelope contract', () => {
    it('needs-llm-step envelope carries sessionId, step, prompt; not filePath or errors', async () => {
      const env = await kickoffSession({content: 'x', projectRoot})
      expect(env.sessionId).to.be.a('string')
      expect(env.step).to.equal('generate-html')
      expect(env.prompt).to.be.a('string')
      expect(env.filePath).to.equal(undefined)
      expect(env.errors).to.equal(undefined)
    })

    it('done envelope carries filePath; not sessionId, step, prompt, or errors', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const {client, simulateEvent} = createMockClient()
      respondWith({client, envelope: okEnvelope(), simulateEvent})

      const env = await continueSession({
        client,
        projectRoot,
        response: VALID_TOPIC_HTML,
        sessionId: kickoff.sessionId!,
      })

      expect(env.filePath).to.be.a('string')
      expect(env.sessionId).to.equal(undefined)
      expect(env.step).to.equal(undefined)
      expect(env.prompt).to.equal(undefined)
      expect(env.errors).to.equal(undefined)
    })

    it('failed envelope carries errors[]; status === failed; ok === false', async () => {
      const {client, simulateEvent} = createMockClient()
      respondWith({client, envelope: okEnvelope(), simulateEvent})

      const env = await continueSession({
        client,
        projectRoot,
        response: 'x',
        sessionId: '00000000-0000-0000-0000-000000000000',
      })

      expect(env.ok).to.equal(false)
      expect(env.status).to.equal('failed')
      expect(env.errors).to.be.an('array').with.length.greaterThan(0)
    })
  })

  // ─── parseCurateResponse — envelope parsing helper ───────────────────────────

  describe('parseCurateResponse', () => {
    it('parses a well-formed envelope with html only', () => {
      const result = parseCurateResponse(envelope(VALID_TOPIC_HTML_RAW))
      expect(result.html).to.equal(VALID_TOPIC_HTML_RAW)
      expect(result.meta).to.be.undefined
    })

    it('parses a well-formed envelope with html and meta', () => {
      const result = parseCurateResponse(envelope(VALID_TOPIC_HTML_RAW, {impact: 'high', type: 'ADD'}))
      expect(result.html).to.equal(VALID_TOPIC_HTML_RAW)
      expect(result.meta).to.deep.equal({impact: 'high', type: 'ADD'})
    })

    it('throws invalid-response-format on malformed JSON', () => {
      let caught: unknown
      try {
        parseCurateResponse('not-json{')
      } catch (error) {
        caught = error
      }

      const err = caught as Error & {kind?: string}
      expect(err.kind).to.equal('invalid-response-format')
      expect(err.message).to.match(/json/i)
    })

    it('throws invalid-response-format when html field is missing', () => {
      let caught: unknown
      try {
        parseCurateResponse(JSON.stringify({meta: {impact: 'high'}}))
      } catch (error) {
        caught = error
      }

      expect((caught as Error & {kind?: string}).kind).to.equal('invalid-response-format')
    })

    it('throws invalid-response-format when html is empty', () => {
      let caught: unknown
      try {
        parseCurateResponse(JSON.stringify({html: ''}))
      } catch (error) {
        caught = error
      }

      expect((caught as Error & {kind?: string}).kind).to.equal('invalid-response-format')
    })

    it('throws invalid-response-format when meta has an invalid enum value', () => {
      let caught: unknown
      try {
        parseCurateResponse(JSON.stringify({html: VALID_TOPIC_HTML_RAW, meta: {impact: 'severe'}}))
      } catch (error) {
        caught = error
      }

      expect((caught as Error & {kind?: string}).kind).to.equal('invalid-response-format')
    })

    it('throws invalid-response-format when meta has unknown keys (.strict)', () => {
      let caught: unknown
      try {
        parseCurateResponse(JSON.stringify({html: VALID_TOPIC_HTML_RAW, meta: {importance: 'high'}}))
      } catch (error) {
        caught = error
      }

      expect((caught as Error & {kind?: string}).kind).to.equal('invalid-response-format')
    })
  })

  // ─── loadCurateResponseFile + deleteCurateResponseFile — file helpers ──────

  describe('loadCurateResponseFile', () => {
    let workDir: string

    beforeEach(async () => {
      workDir = await mkdtemp(join(tmpdir(), 'curate-response-file-load-'))
    })

    afterEach(async () => {
      await rm(workDir, {force: true, recursive: true})
    })

    it('returns the file contents verbatim for a regular file', async () => {
      const filePath = join(workDir, 'envelope.json')
      const contents = JSON.stringify({html: VALID_TOPIC_HTML_RAW})
      await writeFile(filePath, contents, 'utf8')
      const result = await loadCurateResponseFile(filePath)
      expect(result).to.equal(contents)
    })

    it('throws InvalidResponseFileError kind=response-file-read-error when the path does not exist', async () => {
      const missing = join(workDir, 'no-such.json')
      let caught: unknown
      try {
        await loadCurateResponseFile(missing)
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(InvalidResponseFileError)
      const err = caught as InvalidResponseFileError
      expect(err.kind).to.equal('response-file-read-error')
      expect(err.message).to.include(missing)
    })

    it('throws InvalidResponseFileError kind=response-file-not-regular for a directory path', async () => {
      const dirPath = join(workDir, 'subdir')
      await mkdir(dirPath)
      let caught: unknown
      try {
        await loadCurateResponseFile(dirPath)
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(InvalidResponseFileError)
      expect((caught as InvalidResponseFileError).kind).to.equal('response-file-not-regular')
    })

    it('throws InvalidResponseFileError kind=response-file-not-regular for a symlink (even to a regular file)', async () => {
      const target = join(workDir, 'real.json')
      const link = join(workDir, 'envelope.json')
      await writeFile(target, JSON.stringify({html: VALID_TOPIC_HTML_RAW}), 'utf8')
      const {symlink} = await import('node:fs/promises')
      await symlink(target, link)

      let caught: unknown
      try {
        await loadCurateResponseFile(link)
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(InvalidResponseFileError)
      expect((caught as InvalidResponseFileError).kind).to.equal('response-file-not-regular')
    })
  })

  describe('deleteCurateResponseFile', () => {
    let workDir: string

    beforeEach(async () => {
      workDir = await mkdtemp(join(tmpdir(), 'curate-response-file-del-'))
    })

    afterEach(async () => {
      await rm(workDir, {force: true, recursive: true})
    })

    it('unlinks a regular file', async () => {
      const filePath = join(workDir, 'envelope.json')
      await writeFile(filePath, '{}', 'utf8')
      await deleteCurateResponseFile(filePath)
      expect(existsSync(filePath)).to.equal(false)
    })

    it('throws InvalidResponseFileError kind=response-file-delete-error when the path does not exist', async () => {
      const missing = join(workDir, 'absent.json')
      let caught: unknown
      try {
        await deleteCurateResponseFile(missing)
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(InvalidResponseFileError)
      expect((caught as InvalidResponseFileError).kind).to.equal('response-file-delete-error')
    })

    it('refuses to unlink a directory (kind=response-file-delete-error)', async () => {
      const dirPath = join(workDir, 'sub')
      await mkdir(dirPath)
      let caught: unknown
      try {
        await deleteCurateResponseFile(dirPath)
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(InvalidResponseFileError)
      expect((caught as InvalidResponseFileError).kind).to.equal('response-file-delete-error')
      // Directory must still exist — guard rejected before unlink.
      expect(existsSync(dirPath)).to.equal(true)
    })

    it('refuses to unlink a symlink even when its target is a regular file (kind=response-file-delete-error)', async () => {
      const target = join(workDir, 'real.json')
      const link = join(workDir, 'envelope.json')
      await writeFile(target, '{}', 'utf8')
      const {symlink} = await import('node:fs/promises')
      await symlink(target, link)

      let caught: unknown
      try {
        await deleteCurateResponseFile(link)
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(InvalidResponseFileError)
      expect((caught as InvalidResponseFileError).kind).to.equal('response-file-delete-error')
      // Both link and target must still exist — guard fired before unlink.
      expect(existsSync(link)).to.equal(true)
      expect(existsSync(target)).to.equal(true)
    })
  })

  // ─── peekCurateSession + buildUnknownSessionEnvelope — pre-flight helpers ──

  describe('peekCurateSession', () => {
    let projectRoot: string

    beforeEach(async () => {
      projectRoot = await mkdtemp(join(tmpdir(), 'curate-session-peek-'))
    })

    afterEach(async () => {
      await rm(projectRoot, {force: true, recursive: true})
    })

    it('returns kind=invalid-format for a non-uuid session id', async () => {
      const result = await peekCurateSession(projectRoot, '../../etc/passwd')
      expect(result.kind).to.equal('invalid-format')
    })

    it('returns kind=not-found for a well-formed but unknown session id', async () => {
      const result = await peekCurateSession(projectRoot, '00000000-0000-0000-0000-000000000000')
      expect(result.kind).to.equal('not-found')
    })

    it('returns kind=ok for an existing session', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      assertDefined(kickoff.sessionId, 'sessionId')
      const result = await peekCurateSession(projectRoot, kickoff.sessionId)
      expect(result.kind).to.equal('ok')
    })

    it('returns kind=not-found after the session has been completed and cleaned up', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      assertDefined(kickoff.sessionId, 'sessionId')
      const {client, simulateEvent} = createMockClient()
      respondWith({client, envelope: okEnvelope(), simulateEvent})

      await continueSession({
        client,
        projectRoot,
        response: VALID_TOPIC_HTML,
        sessionId: kickoff.sessionId,
      })

      const result = await peekCurateSession(projectRoot, kickoff.sessionId)
      expect(result.kind).to.equal('not-found')
    })
  })

  describe('unknownSessionEnvelope', () => {
    it('produces the standard failed envelope with kind=unknown-session for invalid-format', () => {
      const env = unknownSessionEnvelope('not-a-uuid', 'invalid-format')
      expect(env.ok).to.equal(false)
      expect(env.status).to.equal('failed')
      expect(env.errors?.[0]?.kind).to.equal('unknown-session')
      expect(env.errors?.[0]?.message).to.match(/Invalid session id format/i)
    })

    it('produces the standard failed envelope with kind=unknown-session for not-found', () => {
      const env = unknownSessionEnvelope('00000000-0000-0000-0000-000000000000', 'not-found')
      expect(env.ok).to.equal(false)
      expect(env.status).to.equal('failed')
      expect(env.errors?.[0]?.kind).to.equal('unknown-session')
      expect(env.errors?.[0]?.message).to.match(/No active session/i)
    })
  })

  describe('parseCurateResponse — exported error class', () => {
    it('throws InvalidResponseFormatError so callers can narrow with `instanceof`', () => {
      let caught: unknown
      try {
        parseCurateResponse('{not valid json')
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(InvalidResponseFormatError)
      expect((caught as InvalidResponseFormatError).kind).to.equal('invalid-response-format')
    })
  })
})

/**
 * ENG-2925 — CLI curate (tool mode) appears in the Task queue.
 *
 * Before this change, `brv curate --session/--response` wrote the topic
 * file directly in-process and bypassed the daemon's TaskRouter, so no
 * `TaskHistoryEntry` was ever persisted and the curate was invisible to
 * the WebUI Tasks panel. The CLI now routes the write through the
 * daemon's `curate-tool-mode` task type (same path MCP already uses)
 * — TaskRouter's lifecycle hooks persist the entry automatically.
 *
 * This integration test exercises the persistence + read-back path
 * directly against a real TaskRouter + FileTaskHistoryStore. It dispatches
 * a `task:create` for a curate-tool-mode payload that carries
 * `userIntent` (as the CLI now does), drives the completion lifecycle,
 * and asserts:
 *
 *   1. A persisted TaskHistoryEntry exists with `type: 'curate-tool-mode'`
 *      and `status: 'completed'`.
 *   2. The entry's `content` round-trips through the shared encoder so
 *      `userIntent` survives the wire.
 *   3. The WebUI's row-title helper extracts `userIntent` from the entry
 *      so the Tasks panel renders the user's intent instead of the raw
 *      HTML blob.
 *
 * Note on scope. We stub the agent pool — the daemon's `agent-process.ts`
 * curate-tool-mode handler (which calls `writeHtmlTopic`, the log store,
 * the sidecar, and the index regenerator) is covered by its own
 * unit-level coverage (html-writer, curate-html-log, curate-tool-mode
 * payload parsers, MCP brv-curate-tool). This test focuses on the gap
 * the ticket targets: lifecycle visibility through TaskRouter.
 */

import {expect} from 'chai'
import {randomUUID} from 'node:crypto'
import {mkdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {IAgentPool, SubmitTaskResult} from '../../../src/server/core/interfaces/agent/i-agent-pool.js'
import type {IProjectRegistry} from '../../../src/server/core/interfaces/project/i-project-registry.js'
import type {IProjectRouter} from '../../../src/server/core/interfaces/routing/i-project-router.js'
import type {
  ITransportServer,
  RequestHandler,
} from '../../../src/server/core/interfaces/transport/i-transport-server.js'

import {TransportTaskEventNames} from '../../../src/server/core/domain/transport/schemas.js'
import {TaskRouter} from '../../../src/server/infra/process/task-router.js'
import {FileTaskHistoryStore} from '../../../src/server/infra/storage/file-task-history-store.js'
import {decodeCurateHtmlContent, encodeCurateHtmlContent} from '../../../src/shared/transport/curate-html-content.js'
import {
  curateHtmlDirectRowTitle,
  parseCurateHtmlDirectInput,
} from '../../../src/webui/features/tasks/utils/curate-tool-mode.js'

const PROJECT_PATH = '/app'

function makeProjectInfo(projectPath: string) {
  return {
    projectPath,
    registeredAt: Date.now(),
    sanitizedPath: projectPath.replaceAll('/', '_'),
    storagePath: `/data${projectPath}`,
  }
}

function makeStubTransportServer(sandbox: SinonSandbox) {
  const requestHandlers = new Map<string, RequestHandler>()
  const transport: ITransportServer = {
    addToRoom: sandbox.stub(),
    broadcast: sandbox.stub(),
    broadcastTo: sandbox.stub(),
    getPort: sandbox.stub().returns(3000),
    isRunning: sandbox.stub().returns(true),
    onConnection: sandbox.stub(),
    onDisconnection: sandbox.stub(),
    onRequest: sandbox.stub().callsFake((event: string, handler: RequestHandler) => {
      requestHandlers.set(event, handler)
    }),
    removeFromRoom: sandbox.stub(),
    sendTo: sandbox.stub(),
    start: sandbox.stub().resolves(),
    stop: sandbox.stub().resolves(),
  }
  return {requestHandlers, transport}
}

function makeStubAgentPool(sandbox: SinonSandbox): IAgentPool {
  return {
    cancelQueuedTask: sandbox.stub().returns(false),
    getEntries: sandbox.stub().returns([]),
    getSize: sandbox.stub().returns(0),
    handleAgentDisconnected: sandbox.stub(),
    hasAgent: sandbox.stub().returns(false),
    markIdle: sandbox.stub(),
    notifyTaskCompleted: sandbox.stub(),
    shutdown: sandbox.stub().resolves(),
    submitTask: sandbox.stub().resolves({success: true} as SubmitTaskResult),
  }
}

function makeStubProjectRegistry(sandbox: SinonSandbox): IProjectRegistry {
  return {
    get: sandbox.stub().callsFake((path: string) => makeProjectInfo(path)),
    getAll: sandbox.stub().returns(new Map()),
    register: sandbox.stub().callsFake((path: string) => makeProjectInfo(path)),
    unregister: sandbox.stub().returns(true),
  }
}

function makeStubProjectRouter(sandbox: SinonSandbox): IProjectRouter & {broadcastToProject: SinonStub} {
  return {
    addToProjectRoom: sandbox.stub(),
    broadcastToProject: sandbox.stub(),
    getProjectMembers: sandbox.stub().returns([]),
    removeFromProjectRoom: sandbox.stub(),
  }
}

const VALID_TOPIC_HTML = '<bv-topic path="security/auth" title="JWT auth"><bv-reason>x</bv-reason></bv-topic>'
const USER_INTENT = 'remember the JWT signing rotation policy'

describe('ENG-2925 — CLI curate appears in Task queue', () => {
  let sandbox: SinonSandbox
  let transportHelper: ReturnType<typeof makeStubTransportServer>
  let agentPool: ReturnType<typeof makeStubAgentPool>
  let projectRegistry: ReturnType<typeof makeStubProjectRegistry>
  let projectRouter: ReturnType<typeof makeStubProjectRouter>
  let getAgentForProject: SinonStub
  let tempDir: string
  let store: FileTaskHistoryStore
  let router: TaskRouter

  beforeEach(async () => {
    sandbox = createSandbox()
    transportHelper = makeStubTransportServer(sandbox)
    agentPool = makeStubAgentPool(sandbox)
    projectRegistry = makeStubProjectRegistry(sandbox)
    projectRouter = makeStubProjectRouter(sandbox)
    getAgentForProject = sandbox.stub().returns('agent-1')

    tempDir = join(tmpdir(), `brv-eng-2925-${Date.now()}-${randomUUID()}`)
    await mkdir(tempDir, {recursive: true})

    store = new FileTaskHistoryStore({
      baseDir: tempDir,
      maxAgeDays: 0,
      maxEntries: Number.POSITIVE_INFINITY,
      maxIndexBloatRatio: Number.POSITIVE_INFINITY,
      staleThresholdMs: Number.POSITIVE_INFINITY,
    })

    router = new TaskRouter({
      agentPool,
      getAgentForProject,
      getTaskHistoryStore: () => store,
      projectRegistry,
      projectRouter,
      resolveClientProjectPath: () => PROJECT_PATH,
      transport: transportHelper.transport,
    })
    router.setup()
  })

  afterEach(async () => {
    sandbox.restore()
    await rm(tempDir, {force: true, recursive: true})
  })

  /**
   * Drive a curate-tool-mode task to terminal `completed` via the
   * TaskRouter's request handlers, then read it back through the
   * `task:list` handler (the same path the WebUI uses). list merges
   * in-memory + on-disk state, so it picks up the entry even before the
   * async lifecycle-hook persistence has flushed to FileTaskHistoryStore.
   */
  async function dispatchCliCurateAndList(args?: {userIntent?: string}): Promise<{
    row: {content: string; status: string; taskId: string; type: string}
    taskId: string
  }> {
    const taskId = randomUUID()
    const content = encodeCurateHtmlContent({
      confirmOverwrite: false,
      html: VALID_TOPIC_HTML,
      ...(args?.userIntent === undefined ? {} : {userIntent: args.userIntent}),
    })

    const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
    await createHandler!(
      {content, projectPath: PROJECT_PATH, taskId, type: 'curate-tool-mode'},
      'client-1',
    )

    const completedHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.COMPLETED)
    await completedHandler!(
      {
        result: JSON.stringify({
          filePath: 'security/auth.html',
          overwrote: false,
          status: 'ok',
          topicPath: 'security/auth',
        }),
        taskId,
      },
      'agent-1',
    )

    const listHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
    const result = (await listHandler!({projectPath: PROJECT_PATH}, 'client-1')) as {
      tasks: Array<{content: string; status: string; taskId: string; type: string}>
    }

    const row = result.tasks.find((t) => t.taskId === taskId)
    if (!row) throw new Error(`task ${taskId} did not surface in task:list`)
    return {row, taskId}
  }

  it('surfaces a CLI curate as a curate-tool-mode row in task:list (status=completed)', async () => {
    const {row} = await dispatchCliCurateAndList({userIntent: USER_INTENT})
    expect(row.type).to.equal('curate-tool-mode')
    expect(row.status).to.equal('completed')
  })

  it('round-trips userIntent through the persisted content (decoder recovers what the CLI sent)', async () => {
    const {row} = await dispatchCliCurateAndList({userIntent: USER_INTENT})
    const decoded = decodeCurateHtmlContent(row.content)
    expect(decoded.userIntent).to.equal(USER_INTENT)
    expect(decoded.html).to.equal(VALID_TOPIC_HTML)
  })

  it('WebUI row-title helper renders userIntent — not the raw HTML blob — for the persisted entry', async () => {
    // The actual fix the user sees in the Tasks panel: a meaningful row
    // title sourced from the prompt the user typed, instead of the JSON
    // payload's first 60 chars of <bv-topic> markup.
    const {row} = await dispatchCliCurateAndList({userIntent: USER_INTENT})

    // Sanity: parseCurateHtmlDirectInput agrees with the helper.
    const parsed = parseCurateHtmlDirectInput(row.content)
    expect(parsed?.userIntent).to.equal(USER_INTENT)
    expect(curateHtmlDirectRowTitle(row.content)).to.equal(USER_INTENT)
  })

  it('an MCP-style curate (no userIntent) still appears in the task list, falling back to the topic path', async () => {
    // Regression guard: the userIntent plumbing is optional and must not
    // break the pre-existing MCP path (brv-curate tool dispatches without
    // a tracked intent). Row title falls back to the bv-topic path attr.
    const {row} = await dispatchCliCurateAndList()
    const decoded = decodeCurateHtmlContent(row.content)
    expect(decoded.userIntent).to.equal(undefined)
    expect(curateHtmlDirectRowTitle(row.content)).to.equal('security/auth')
  })
})

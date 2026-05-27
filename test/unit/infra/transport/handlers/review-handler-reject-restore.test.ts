/**
 * End-to-end "curate UPDATE → reject restores prior content" guardrail.
 *
 * The CLI/daemon backup-seeding helper has its own unit tests, but those only
 * prove the *necessary* condition (backup file exists with the right bytes).
 * This file proves the *sufficient* condition: that the seeded backup, keyed
 * the way the curate side keys it, actually causes review-handler's reject
 * path to RESTORE the file rather than `unlink` it (which is what happens when
 * `backupStore.read()` returns null).
 *
 * If the curate side and the handler side ever drift on keying (Windows
 * separators, a `relative()` rooted at a different dir, etc.), the unit tests
 * stay green while production silently deletes the user's content. This test
 * is the durable contract guard.
 *
 * Implementation note. CLI curate now dispatches `curate-tool-mode` to the
 * daemon — there is no in-process write to assert against on the CLI side.
 * The test replicates the daemon's curate-tool-mode sequence inline
 * (`backupContextTreeFile` → `writeHtmlTopic` → `buildCurateHtmlLogEntry` →
 * `FileCurateLogStore.save`) using the SAME shared helpers the daemon uses.
 * Anything that drifts between this fixture and `agent-process.ts`'s
 * curate-tool-mode case breaks this test — which is the point.
 *
 * Lives in its own file because mocha/max-top-level-suites caps one
 * top-level `describe` per file.
 */

import type {SinonStub} from 'sinon'

import {expect} from 'chai'
import {randomUUID} from 'node:crypto'
import {existsSync} from 'node:fs'
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {restore, stub} from 'sinon'

import type {IProjectConfigStore} from '../../../../../src/server/core/interfaces/storage/i-project-config-store.js'
import type {CurateMeta} from '../../../../../src/shared/curate-meta.js'

import {BRV_DIR, CONTEXT_TREE_DIR} from '../../../../../src/server/constants.js'
import {BrvConfig} from '../../../../../src/server/core/domain/entities/brv-config.js'
import {backupContextTreeFile, buildCurateHtmlLogEntry} from '../../../../../src/server/infra/process/curate-html-log.js'
import {writeHtmlTopic} from '../../../../../src/server/infra/render/writer/html-writer.js'
import {FileCurateLogStore} from '../../../../../src/server/infra/storage/file-curate-log-store.js'
import {FileReviewBackupStore} from '../../../../../src/server/infra/storage/file-review-backup-store.js'
import {ReviewHandler} from '../../../../../src/server/infra/transport/handlers/review-handler.js'
import {getProjectDataDir} from '../../../../../src/server/utils/path-utils.js'
import {ReviewEvents} from '../../../../../src/shared/transport/events/review-events.js'
import {createMockTransportServer, type MockTransportServer} from '../../../../helpers/mock-factories.js'

/**
 * Run the daemon's curate-tool-mode write sequence directly in-process,
 * keyed by `taskId`. Mirrors `agent-process.ts > case 'curate-tool-mode'`:
 *
 *   1. resolve absolute target path
 *   2. seed review-backup BEFORE the destructive write (if a file exists)
 *   3. writeHtmlTopic atomically
 *   4. buildCurateHtmlLogEntry + FileCurateLogStore.save
 *
 * Returns the taskId so the test can drive `review:decideTask` against it.
 */
async function daemonCurate(args: {
  html: string
  meta?: CurateMeta
  projectRoot: string
  taskId: string
  userIntent?: string
}): Promise<void> {
  const {html, meta, projectRoot, taskId, userIntent} = args
  const contextTreeRoot = join(projectRoot, BRV_DIR, CONTEXT_TREE_DIR)
  const reviewBackupStore = new FileReviewBackupStore(join(projectRoot, BRV_DIR))
  const curateLogStore = new FileCurateLogStore({baseDir: getProjectDataDir(projectRoot)})

  // Pre-compute the absolute target so we can seed the backup before the write.
  // The path matches what writeHtmlTopic will derive internally.
  const topicPathMatch = /<bv-topic\b[^>]*\bpath="([^"]+)"/i.exec(html)
  const topicPath = topicPathMatch?.[1]
  const absoluteFilePath = topicPath ? join(contextTreeRoot, `${topicPath}.html`) : undefined
  const existedBefore = absoluteFilePath !== undefined && existsSync(absoluteFilePath)

  if (existedBefore && absoluteFilePath !== undefined) {
    await backupContextTreeFile({
      absoluteFilePath,
      contextTreeRoot,
      reviewBackupStore,
      reviewDisabled: false,
    })
  }

  const startedAt = Date.now()
  const writeResult = await writeHtmlTopic({confirmOverwrite: existedBefore, contextTreeRoot, rawHtml: html})
  const completedAt = Date.now()

  const id = await curateLogStore.getNextId()
  const entry = buildCurateHtmlLogEntry({
    completedAt,
    confirmOverwrite: existedBefore,
    existedBefore,
    filePath: writeResult.ok ? writeResult.filePath : undefined,
    id,
    intent: userIntent,
    meta,
    reviewDisabled: false,
    startedAt,
    taskId,
    topicPath,
    writeResult,
  })
  await curateLogStore.save(entry)
}

describe('ReviewHandler — curate UPDATE → reject restores prior content (e2e contract)', () => {
  let projectRoot: string
  let transport: MockTransportServer
  let projectConfigStore: Partial<IProjectConfigStore> & {read: SinonStub; write: SinonStub}

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'review-handler-e2e-'))
    await mkdir(join(projectRoot, BRV_DIR, CONTEXT_TREE_DIR), {recursive: true})
    transport = createMockTransportServer()
    projectConfigStore = {
      read: stub().resolves(BrvConfig.createLocal({cwd: projectRoot})),
      write: stub().resolves(),
    }
  })

  afterEach(async () => {
    restore()
    await rm(projectRoot, {force: true, recursive: true})
  })

  function buildRealHandler(): ReviewHandler {
    // Real stores rooted at the test's tmpdir — no stubs. The curate side wrote
    // entries + backups via `FileCurateLogStore.save` / `FileReviewBackupStore.save`
    // keyed by relative context-tree path. The handler reads via the SAME stores
    // with paths derived the same way. Anything that drifts breaks this test.
    const handler = new ReviewHandler({
      curateLogStoreFactory: () => new FileCurateLogStore({baseDir: getProjectDataDir(projectRoot)}),
      projectConfigStore: projectConfigStore as IProjectConfigStore,
      resolveProjectPath: () => projectRoot,
      reviewBackupStoreFactory: () => new FileReviewBackupStore(join(projectRoot, BRV_DIR)),
      transport,
    })
    handler.setup()
    return handler
  }

  async function callReject(taskId: string): Promise<unknown> {
    const handler = transport._handlers.get(ReviewEvents.DECIDE_TASK)
    expect(handler, 'review:decideTask handler should be registered').to.exist
    return handler!({decision: 'rejected', taskId}, 'client-1')
  }

  it('rejecting an UPDATE-shaped curate restores the file to its prior content (not delete)', async () => {
    const topicPath = 'security/auth.html'
    const onDisk = join(projectRoot, BRV_DIR, CONTEXT_TREE_DIR, topicPath)
    const originalHtml =
      '<bv-topic path="security/auth" title="JWT auth"><bv-decision id="d-orig">ORIGINAL — must survive reject.</bv-decision></bv-topic>'
    const updatedHtml =
      '<bv-topic path="security/auth" title="JWT auth"><bv-decision id="d-bad">BAD UPDATE — should be reverted.</bv-decision></bv-topic>'

    // 1. Seed the topic via an initial ADD.
    await daemonCurate({
      html: originalHtml,
      meta: {impact: 'high', type: 'ADD'},
      projectRoot,
      taskId: randomUUID(),
    })
    const originalOnDisk = await readFile(onDisk, 'utf8')

    // 2. Run an UPDATE that lands as `reviewStatus: 'pending'` (meta.impact:'high')
    //    AND seeds the review-backup with the original bytes. We use a known taskId
    //    so the reject below can target this exact operation.
    const updateTaskId = randomUUID()
    await daemonCurate({
      html: updatedHtml,
      meta: {impact: 'high', type: 'UPDATE'},
      projectRoot,
      taskId: updateTaskId,
    })

    // 3. Drive the actual reject through the handler — same code path `brv review reject` runs.
    buildRealHandler()
    await callReject(updateTaskId)

    // 4. THE contract: file must be RESTORED to original bytes — not unlinked,
    //    not left as the BAD UPDATE.
    expect(existsSync(onDisk), 'file must still exist after reject (NOT unlinked)').to.equal(true)
    const afterReject = await readFile(onDisk, 'utf8')
    expect(afterReject, 'file must be restored to original content').to.equal(originalOnDisk)
    expect(afterReject).to.include('ORIGINAL — must survive reject.')
    expect(afterReject).to.not.include('BAD UPDATE')
  })

  it('rejecting an ADD-shaped curate unlinks the file (no backup, no restore — matches main)', async () => {
    const topicPath = 'security/auth.html'
    const onDisk = join(projectRoot, BRV_DIR, CONTEXT_TREE_DIR, topicPath)
    const html =
      '<bv-topic path="security/auth" title="JWT auth"><bv-decision id="d-new">New topic.</bv-decision></bv-topic>'

    // ADD a high-impact topic — pending review, no prior file → no backup created.
    const addTaskId = randomUUID()
    await daemonCurate({
      html,
      meta: {impact: 'high', type: 'ADD'},
      projectRoot,
      taskId: addTaskId,
    })
    expect(existsSync(onDisk)).to.equal(true)

    buildRealHandler()
    await callReject(addTaskId)

    // ADD reject unlinks (there's nothing to restore to) — same as main's behaviour.
    expect(existsSync(onDisk), 'file is unlinked on ADD reject').to.equal(false)
  })
})

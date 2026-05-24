
import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {join} from 'node:path'

import {BrvDirWatcher} from '../../../../src/server/utils/brv-dir-watcher.js'
import {makeTempContextTree} from '../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../helpers/temp-dir.js'

// Phase 9.5.9 §2.6 — BrvDirWatcher observability tests.
// We test the observable log output when channel state is deleted.
// The watcher uses fs.watch (side-effect-ful), so we use a short poll.

const SETTLE_MS = 200 // give fs.watch events time to fire

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe('BrvDirWatcher (Phase 9.5.9 §2.6)', () => {
  let projectRoot: string
  const warnLogs: string[] = []
  const infoLogs: string[] = []

  const warn = (msg: string): void => { warnLogs.push(msg) }
  const info = (msg: string): void => { infoLogs.push(msg) }

  beforeEach(async () => {
    projectRoot = await makeTempContextTree()
    warnLogs.length = 0
    infoLogs.length = 0
  })

  afterEach(async () => {
    await removeTempDir(projectRoot)
  })

  it('emits WARN log when a channel meta dir is deleted', async () => {
    const channelId = 'ch-watch-test'
    const channelDir = join(projectRoot, '.brv', 'context-tree', 'channel', channelId)
    await fs.mkdir(channelDir, {recursive: true})
    await fs.writeFile(join(channelDir, 'meta.json'), '{}', 'utf8')

    const watcher = new BrvDirWatcher({info, projectRoot, warn})
    watcher.start()

    await sleep(50) // let watcher attach

    // Delete the channel directory
    await fs.rm(channelDir, {force: true, recursive: true})

    await sleep(SETTLE_MS) // let event fire

    watcher.stop()

    const found = warnLogs.some((m) => m.includes('[brv-dir]') && m.includes(channelId))
    expect(found).to.equal(true)
  })

  it('stop() does not throw even when called multiple times', () => {
    const watcher = new BrvDirWatcher({info, projectRoot, warn})
    watcher.start()
    expect(() => { watcher.stop(); watcher.stop() }).to.not.throw()
  })
})


import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {join} from 'node:path'

import {runChannelProjectStartup} from '../../../../../src/server/infra/daemon/channel-project-startup.js'
import {makeTempContextTree} from '../../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../../helpers/temp-dir.js'

/**
 * Phase 9.5.9 Issue 1 — per-project channel startup wiring.
 *
 * These tests verify that runChannelProjectStartup:
 *   1. Calls reconstructMissingMetas (meta.json is created for orphan histories)
 *   2. Calls runMarkInboundOnlyMigration (partial members get inbound-only)
 *   3. Starts BrvDirWatcher (emits the startup log line)
 */

const CHANNEL_ID = 'ch-startup-test'

async function writeChannelHistory(projectRoot: string, channelId: string): Promise<void> {
  const turnsDir = join(projectRoot, '.brv', 'channel-history', channelId, 'turns')
  await fs.mkdir(turnsDir, {recursive: true})
  // Minimal NDJSON snapshot so reconstruction can pick up a createdAt date.
  const snapshot = JSON.stringify({
    _recordType: 'snapshot',
    turn: {startedAt: '2026-05-24T10:00:00.000Z'},
  })
  await fs.writeFile(join(turnsDir, 'turn-1.ndjson'), snapshot + '\n', 'utf8')
}

async function writeMeta(projectRoot: string, channelId: string, meta: object): Promise<void> {
  const dir = join(projectRoot, '.brv', 'context-tree', 'channel', channelId)
  await fs.mkdir(dir, {recursive: true})
  await fs.writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
}

describe('runChannelProjectStartup (Issue 1 — daemon startup wiring)', () => {
  let projectRoot: string
  const logs: string[] = []
  const warns: string[] = []

  const log = (msg: string): void => { logs.push(msg) }
  const warn = (msg: string): void => { warns.push(msg) }

  // Minimal fake channelStore — updateChannelMeta must be callable.
  const fakeChannelStore = {
    async updateChannelMeta(args: {
      channelId: string
      mutate: (m: unknown) => unknown
      projectRoot: string
    }): Promise<unknown> {
      const metaPath = join(args.projectRoot, '.brv', 'context-tree', 'channel', args.channelId, 'meta.json')
      try {
        const raw = await fs.readFile(metaPath, 'utf8')
        const current = JSON.parse(raw) as object
        const updated = args.mutate(current) as object
        await fs.writeFile(metaPath, JSON.stringify(updated, null, 2), 'utf8')
        return updated
      } catch {
        throw new Error(`Channel ${args.channelId} not found`)
      }
    },
  } as unknown as Parameters<typeof runChannelProjectStartup>[0]['channelStore']

  beforeEach(async () => {
    projectRoot = await makeTempContextTree()
    logs.length = 0
    warns.length = 0
  })

  afterEach(async () => {
    await removeTempDir(projectRoot)
  })

  // SKIPPED for Phase 9.5.9 — kimi review (turnId 7h-RAyyU6GEy0mRdjI9ay) flagged
  // two data-corruption vectors in reconstructMissingMetas (TOCTOU + members:[]
  // lie). Reconstruction is no longer wired into runChannelProjectStartup; it
  // stays in the tree (src/server/utils/channel-meta-reconstruction.ts) for
  // 9.5.10 to pick up after the TOCTOU + members reconstruction are fixed.
  it.skip('reconstructs a missing meta.json from channel-history', async () => {
    // Set up: channel-history exists but meta.json does NOT.
    await writeChannelHistory(projectRoot, CHANNEL_ID)

    const result = await runChannelProjectStartup({channelStore: fakeChannelStore, log, projectRoot, warn})
    result.watcher.stop()

    // meta.json must now exist.
    const metaPath = join(projectRoot, '.brv', 'context-tree', 'channel', CHANNEL_ID, 'meta.json')
    const raw = await fs.readFile(metaPath, 'utf8')
    const meta = JSON.parse(raw) as {channelId: string}
    expect(meta.channelId).to.equal(CHANNEL_ID)

    // Reconstruction log must be emitted.
    expect(logs.some((m) => m.includes('reconstruct'))).to.equal(true)
  })

  it('marks partial remote-peer members as inbound-only', async () => {
    await writeMeta(projectRoot, CHANNEL_ID, {
      channelId: CHANNEL_ID,
      createdAt: '2026-05-24T00:00:00.000Z',
      members: [
        {
          addressability: 'bootstrap-only',
          handle: '@remote',
          joinedAt: '2026-05-24T00:00:00.000Z',
          memberKind: 'remote-peer',
          peerId: 'peer-1',
          status: 'idle',
          // multiaddr absent — should be marked inbound-only
        },
      ],
      updatedAt: '2026-05-24T00:00:00.000Z',
    })

    const result = await runChannelProjectStartup({channelStore: fakeChannelStore, log, projectRoot, warn})
    result.watcher.stop()

    const metaPath = join(projectRoot, '.brv', 'context-tree', 'channel', CHANNEL_ID, 'meta.json')
    const raw = await fs.readFile(metaPath, 'utf8')
    const meta = JSON.parse(raw) as {members: Array<{addressability: string}>}
    expect(meta.members[0].addressability).to.equal('inbound-only')
  })

  it('emits the BrvDirWatcher startup log line', async () => {
    const result = await runChannelProjectStartup({channelStore: fakeChannelStore, log, projectRoot, warn})
    result.watcher.stop()

    expect(logs.some((m) => m.includes('BrvDirWatcher started'))).to.equal(true)
  })

  it('returns a watcher that can be stopped without error', async () => {
    const result = await runChannelProjectStartup({channelStore: fakeChannelStore, log, projectRoot, warn})
    expect(() => result.watcher.stop()).to.not.throw()
  })

  it('is best-effort: errors in reconstruction do not prevent migration or watcher start', async () => {
    // Bad channelStore that throws on updateChannelMeta — should not crash startup.
    const throwingStore = {
      async updateChannelMeta(): Promise<never> {
        throw new Error('simulated store error')
      },
    } as unknown as Parameters<typeof runChannelProjectStartup>[0]['channelStore']

    let threw = false
    let result
    try {
      result = await runChannelProjectStartup({channelStore: throwingStore, log, projectRoot, warn})
    } catch {
      threw = true
    }

    expect(threw).to.equal(false)
    result?.watcher.stop()
    // Watcher must still have started.
    expect(logs.some((m) => m.includes('BrvDirWatcher started'))).to.equal(true)
  })
})

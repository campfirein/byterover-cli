
import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {join} from 'node:path'

import {runMarkInboundOnlyMigration} from '../../../../../src/server/infra/channel/migrations/mark-inbound-only.js'
import {makeTempContextTree} from '../../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../../helpers/temp-dir.js'

/**
 * Phase 9.5.9 Issue 4 — migration must go through ChannelStore.updateChannelMeta
 * (which uses the write-serializer lock) rather than raw readFile+writeFile.
 *
 * These tests confirm that when a ChannelStore is passed in, its
 * updateChannelMeta method is called (not raw FS writes).  Before the fix
 * the migration accepts no channelStore arg, so these tests FAIL.
 */

const CHANNEL_ID = 'ch-migrate-lock-test'

async function writeMeta(projectRoot: string, channelId: string, meta: object): Promise<void> {
  const dir = join(projectRoot, '.brv', 'context-tree', 'channel', channelId)
  await fs.mkdir(dir, {recursive: true})
  await fs.writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
}

async function readMeta(projectRoot: string, channelId: string): Promise<object> {
  const path = join(projectRoot, '.brv', 'context-tree', 'channel', channelId, 'meta.json')
  return JSON.parse(await fs.readFile(path, 'utf8')) as object
}

describe('runMarkInboundOnlyMigration — channelStore locking (Issue 4)', () => {
  let projectRoot: string
  const infos: string[] = []
  const log = (msg: string): void => { infos.push(msg) }

  beforeEach(async () => {
    projectRoot = await makeTempContextTree()
    infos.length = 0
  })

  afterEach(async () => {
    await removeTempDir(projectRoot)
  })

  it('accepts an optional channelStore and uses it for atomic updates when provided', async () => {
    await writeMeta(projectRoot, CHANNEL_ID, {
      channelId: CHANNEL_ID,
      createdAt: '2026-05-24T00:00:00.000Z',
      members: [
        {
          addressability: 'bootstrap-only',
          handle: '@remote-lock',
          joinedAt: '2026-05-24T00:00:00.000Z',
          memberKind: 'remote-peer',
          peerId: 'peer-lock',
          status: 'idle',
        },
      ],
      updatedAt: '2026-05-24T00:00:00.000Z',
    })

    // Track whether updateChannelMeta was called.
    let updateCalled = false
    const fakeChannelStore = {
      async updateChannelMeta(args: {channelId: string; mutate: (m: unknown) => unknown; projectRoot: string}): Promise<unknown> {
        updateCalled = true
        // Read the real file and apply the mutation, then write it back —
        // simulates what a real channelStore does.
        const metaPath = join(args.projectRoot, '.brv', 'context-tree', 'channel', args.channelId, 'meta.json')
        const raw = await fs.readFile(metaPath, 'utf8')
        const current = JSON.parse(raw) as object
        const updated = args.mutate(current)
        await fs.writeFile(metaPath, JSON.stringify(updated, null, 2), 'utf8')
        return updated
      },
    } as unknown as Parameters<typeof runMarkInboundOnlyMigration>[0]['channelStore']

    await runMarkInboundOnlyMigration({channelStore: fakeChannelStore, log, projectRoot})

    expect(updateCalled).to.equal(true, 'channelStore.updateChannelMeta must be called when a store is provided')

    const after = await readMeta(projectRoot, CHANNEL_ID) as {members: Array<{addressability: string}>}
    expect(after.members[0].addressability).to.equal('inbound-only')
  })

  it('falls back to direct FS writes when channelStore is absent (backward compat)', async () => {
    await writeMeta(projectRoot, CHANNEL_ID, {
      channelId: CHANNEL_ID,
      createdAt: '2026-05-24T00:00:00.000Z',
      members: [
        {
          addressability: 'bootstrap-only',
          handle: '@remote-fs',
          joinedAt: '2026-05-24T00:00:00.000Z',
          memberKind: 'remote-peer',
          peerId: 'peer-fs',
          status: 'idle',
        },
      ],
      updatedAt: '2026-05-24T00:00:00.000Z',
    })

    // No channelStore passed — should still work via direct FS path.
    await runMarkInboundOnlyMigration({log, projectRoot})

    const after = await readMeta(projectRoot, CHANNEL_ID) as {members: Array<{addressability: string}>}
    expect(after.members[0].addressability).to.equal('inbound-only')
  })
})

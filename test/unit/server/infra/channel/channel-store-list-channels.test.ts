
import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {join} from 'node:path'

import {ChannelStore} from '../../../../../src/server/infra/channel/channel-store.js'
import {ChannelEventsWriter} from '../../../../../src/server/infra/channel/storage/events-writer.js'
import {ChannelSnapshotWriter} from '../../../../../src/server/infra/channel/storage/snapshot-writer.js'
import {ChannelTreeReader} from '../../../../../src/server/infra/channel/storage/tree-reader.js'
import {ChannelWriteSerializer} from '../../../../../src/server/infra/channel/storage/write-serializer.js'
import {makeTempContextTree} from '../../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../../helpers/temp-dir.js'

// Phase 9.5.9 §2.4 — listChannels skip-not-fail tolerance.
// A single malformed meta must not cause the whole list to fail.

const VALID_META_A = JSON.stringify({
  channelId: 'chan-a',
  createdAt: '2026-05-24T00:00:00.000Z',
  members: [],
  updatedAt: '2026-05-24T00:00:00.000Z',
})

const VALID_META_B = JSON.stringify({
  channelId: 'chan-b',
  createdAt: '2026-05-24T00:00:00.000Z',
  members: [],
  updatedAt: '2026-05-24T00:00:00.000Z',
})

const VALID_META_C = JSON.stringify({
  channelId: 'chan-c',
  createdAt: '2026-05-24T00:00:00.000Z',
  members: [],
  updatedAt: '2026-05-24T00:00:00.000Z',
})

const VALID_META_D = JSON.stringify({
  channelId: 'chan-d',
  createdAt: '2026-05-24T00:00:00.000Z',
  members: [],
  updatedAt: '2026-05-24T00:00:00.000Z',
})

const MALFORMED = '{not json{{'

async function writeChannelMeta(projectRoot: string, channelId: string, content: string): Promise<void> {
  const dir = join(projectRoot, '.brv', 'context-tree', 'channel', channelId)
  await fs.mkdir(dir, {recursive: true})
  await fs.writeFile(join(dir, 'meta.json'), content, 'utf8')
}

describe('ChannelStore.listChannels (Phase 9.5.9 §2.4 skip-not-fail)', () => {
  let projectRoot: string
  const skippedIds: string[] = []
  let store: ChannelStore

  beforeEach(async () => {
    skippedIds.length = 0
    projectRoot = await makeTempContextTree()
    const serializer = new ChannelWriteSerializer()
    store = new ChannelStore({
      eventsWriter: new ChannelEventsWriter({serializer}),
      log(_msg: string) { /* suppress */ },
      snapshotWriter: new ChannelSnapshotWriter({eventsWriter: new ChannelEventsWriter({serializer: new ChannelWriteSerializer()})}),
      treeReader: new ChannelTreeReader(),
      writeSerializer: serializer,
    })
  })

  afterEach(async () => {
    await removeTempDir(projectRoot)
  })

  it('returns all channels when all metas are valid', async () => {
    await writeChannelMeta(projectRoot, 'chan-a', VALID_META_A)
    await writeChannelMeta(projectRoot, 'chan-b', VALID_META_B)
    await writeChannelMeta(projectRoot, 'chan-c', VALID_META_C)

    const channels = await store.listChannels({projectRoot})
    expect(channels).to.have.length(3)
    const ids = channels.map((c) => c.channelId).sort()
    expect(ids).to.deep.equal(['chan-a', 'chan-b', 'chan-c'])
  })

  it('skips one malformed meta and returns the rest (3 of 4)', async () => {
    await writeChannelMeta(projectRoot, 'chan-a', VALID_META_A)
    await writeChannelMeta(projectRoot, 'chan-bad', MALFORMED)
    await writeChannelMeta(projectRoot, 'chan-c', VALID_META_C)
    await writeChannelMeta(projectRoot, 'chan-d', VALID_META_D)

    const channels = await store.listChannels({projectRoot})
    expect(channels).to.have.length(3)
    const ids = channels.map((c) => c.channelId).sort()
    expect(ids).to.deep.equal(['chan-a', 'chan-c', 'chan-d'])
  })

  it('returns empty array when ALL metas are malformed (not an error)', async () => {
    await writeChannelMeta(projectRoot, 'bad-1', MALFORMED)
    await writeChannelMeta(projectRoot, 'bad-2', '{}')

    const channels = await store.listChannels({projectRoot})
    expect(channels).to.deep.equal([])
  })

  it('returns empty array when the channel directory does not exist', async () => {
    const channels = await store.listChannels({projectRoot})
    expect(channels).to.deep.equal([])
  })
})

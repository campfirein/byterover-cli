
import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {join} from 'node:path'

import {reconstructMissingMetas} from '../../../../src/server/utils/channel-meta-reconstruction.js'
import {makeTempContextTree} from '../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../helpers/temp-dir.js'

// Phase 9.5.9 §2.6 — channel meta reconstruction from channel-history.
// On daemon startup, if channel-history/<id>/ exists but meta.json is
// missing, reconstruct a minimal meta from the turn snapshot.

const CHANNEL_ID = 'ch-reconstruct'

async function writeHistorySnapshot(projectRoot: string, channelId: string): Promise<void> {
  const turnsDir = join(projectRoot, '.brv', 'channel-history', channelId, 'turns')
  await fs.mkdir(turnsDir, {recursive: true})
  // Write a minimal turn ndjson with a snapshot record
  const snapshot = {
    _recordType: 'snapshot',
    turn: {
      author: {handle: 'you', kind: 'local-user'},
      channelId,
      mentions: ['@alice'],
      promptBlocks: [],
      promptedBy: 'user',
      startedAt: '2026-05-24T10:00:00.000Z',
      state: 'completed',
      turnId: 'turn-abc',
    },
  }
  await fs.writeFile(join(turnsDir, 'turn-abc.ndjson'), JSON.stringify(snapshot) + '\n', 'utf8')
}

describe('reconstructMissingMetas() (Phase 9.5.9 §2.6)', () => {
  let projectRoot: string
  const infoLogs: string[] = []
  const log = (msg: string): void => { infoLogs.push(msg) }

  beforeEach(async () => {
    projectRoot = await makeTempContextTree()
    infoLogs.length = 0
  })

  afterEach(async () => {
    await removeTempDir(projectRoot)
  })

  it('creates minimal meta.json when channel-history exists but meta.json is missing', async () => {
    await writeHistorySnapshot(projectRoot, CHANNEL_ID)

    await reconstructMissingMetas({log, projectRoot})

    const metaPath = join(projectRoot, '.brv', 'context-tree', 'channel', CHANNEL_ID, 'meta.json')
    const raw = JSON.parse(await fs.readFile(metaPath, 'utf8')) as {channelId: string; members: unknown[]}
    expect(raw.channelId).to.equal(CHANNEL_ID)
    expect(raw.members).to.be.an('array')
  })

  it('emits an INFO log for every reconstructed channel', async () => {
    await writeHistorySnapshot(projectRoot, CHANNEL_ID)

    await reconstructMissingMetas({log, projectRoot})

    const found = infoLogs.some((m) => m.includes(CHANNEL_ID) && m.includes('reconstruct'))
    expect(found).to.equal(true)
  })

  it('does not overwrite an existing meta.json', async () => {
    await writeHistorySnapshot(projectRoot, CHANNEL_ID)
    const metaDir = join(projectRoot, '.brv', 'context-tree', 'channel', CHANNEL_ID)
    await fs.mkdir(metaDir, {recursive: true})
    const originalMeta = {
      channelId: CHANNEL_ID,
      createdAt: '2026-01-01T00:00:00.000Z',
      members: [{handle: '@existing'}],
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    await fs.writeFile(join(metaDir, 'meta.json'), JSON.stringify(originalMeta), 'utf8')

    await reconstructMissingMetas({log, projectRoot})

    const after = JSON.parse(
      await fs.readFile(join(metaDir, 'meta.json'), 'utf8'),
    ) as typeof originalMeta
    expect(after.createdAt).to.equal('2026-01-01T00:00:00.000Z')
  })

  it('does nothing when there is no channel-history directory', async () => {
    let threw = false
    try {
      await reconstructMissingMetas({log, projectRoot})
    } catch {
      threw = true
    }

    expect(threw).to.equal(false)
    expect(infoLogs).to.have.length(0)
  })
})

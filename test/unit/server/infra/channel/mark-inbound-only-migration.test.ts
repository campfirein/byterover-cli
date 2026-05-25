
import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {join} from 'node:path'

import {runMarkInboundOnlyMigration} from '../../../../../src/server/infra/channel/migrations/mark-inbound-only.js'
import {makeTempContextTree} from '../../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../../helpers/temp-dir.js'

// Phase 9.5.9 §2.5 — opportunistic startup migration.
// Existing remote-peer members with missing multiaddr OR remoteL2PubKey
// get upgraded to addressability='inbound-only'.

const CHANNEL_ID = 'ch-migrate-test'

async function writeMeta(projectRoot: string, channelId: string, meta: object): Promise<void> {
  const dir = join(projectRoot, '.brv', 'context-tree', 'channel', channelId)
  await fs.mkdir(dir, {recursive: true})
  await fs.writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
}

async function readMeta(projectRoot: string, channelId: string): Promise<object> {
  const path = join(projectRoot, '.brv', 'context-tree', 'channel', channelId, 'meta.json')
  return JSON.parse(await fs.readFile(path, 'utf8')) as object
}

describe('runMarkInboundOnlyMigration (Phase 9.5.9 §2.5)', () => {
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

  it('upgrades a partial remote-peer member (missing multiaddr) to inbound-only', async () => {
    await writeMeta(projectRoot, CHANNEL_ID, {
      channelId: CHANNEL_ID,
      createdAt: '2026-05-24T00:00:00.000Z',
      members: [
        {
          addressability: 'bootstrap-only',
          handle: '@remote',
          joinedAt: '2026-05-24T00:00:00.000Z',
          memberKind: 'remote-peer',
          peerId: 'peer-xyz',
          status: 'idle',
          // multiaddr absent; remoteL2PubKey absent
        },
      ],
      updatedAt: '2026-05-24T00:00:00.000Z',
    })

    await runMarkInboundOnlyMigration({log, projectRoot})

    const after = await readMeta(projectRoot, CHANNEL_ID) as {members: Array<{addressability: string}>}
    expect(after.members[0].addressability).to.equal('inbound-only')
  })

  it('leaves a fully-populated member (has multiaddr AND L2) as bootstrap-only', async () => {
    await writeMeta(projectRoot, CHANNEL_ID, {
      channelId: CHANNEL_ID,
      createdAt: '2026-05-24T00:00:00.000Z',
      members: [
        {
          addressability: 'bootstrap-only',
          handle: '@remote',
          joinedAt: '2026-05-24T00:00:00.000Z',
          memberKind: 'remote-peer',
          multiaddr: '/ip4/1.2.3.4/tcp/1234',
          peerId: 'peer-abc',
          remoteL2PubKey: 'base64key',
          status: 'idle',
        },
      ],
      updatedAt: '2026-05-24T00:00:00.000Z',
    })

    await runMarkInboundOnlyMigration({log, projectRoot})

    const after = await readMeta(projectRoot, CHANNEL_ID) as {members: Array<{addressability: string}>}
    expect(after.members[0].addressability).to.equal('bootstrap-only')
  })

  it('is idempotent — running twice on an already-marked member is a no-op', async () => {
    await writeMeta(projectRoot, CHANNEL_ID, {
      channelId: CHANNEL_ID,
      createdAt: '2026-05-24T00:00:00.000Z',
      members: [
        {
          addressability: 'inbound-only',
          handle: '@remote',
          joinedAt: '2026-05-24T00:00:00.000Z',
          memberKind: 'remote-peer',
          peerId: 'peer-xyz',
          status: 'idle',
        },
      ],
      updatedAt: '2026-05-24T00:00:00.000Z',
    })

    await runMarkInboundOnlyMigration({log, projectRoot})
    await runMarkInboundOnlyMigration({log, projectRoot})

    const after = await readMeta(projectRoot, CHANNEL_ID) as {members: Array<{addressability: string}>}
    expect(after.members[0].addressability).to.equal('inbound-only')
    // Only first run should log; second run is a no-op
    const migrationLogs = infos.filter((m) => m.includes('inbound-only'))
    // first run logs 0 (already inbound-only), second run also 0
    expect(migrationLogs.length).to.equal(0)
  })

  it('skips channels without meta.json (does not throw)', async () => {
    // Create channel dir without meta.json
    const dir = join(projectRoot, '.brv', 'context-tree', 'channel', 'ch-no-meta')
    await fs.mkdir(dir, {recursive: true})

    let threw = false
    try {
      await runMarkInboundOnlyMigration({log, projectRoot})
    } catch {
      threw = true
    }

    expect(threw).to.equal(false)
  })
})

import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {
  computeLivePending,
  FileBrokerPersistence,
} from '../../../../../../src/server/infra/channel/drivers/broker-persistence.js'

describe('Broker persistence (Phase 3.5c)', () => {
describe('FileBrokerPersistence', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(join(tmpdir(), 'brv-broker-persist-'))
  })

  afterEach(async () => {
    await fs.rm(dataDir, {force: true, recursive: true})
  })

  it('appendTrack + appendResolve produce a parseable JSONL log', async () => {
    const store = new FileBrokerPersistence({dataDir})
    await store.appendTrack({
      channelId: 'c',
      deliveryId: 'd1',
      memberHandle: '@a',
      permissionRequestId: 'p1',
      projectRoot: '/proj',
      turnId: 't1',
    })
    await store.appendResolve({permissionRequestId: 'p1'})

    const records = await store.readAll()
    expect(records).to.have.lengthOf(2)
    expect(records[0].type).to.equal('track')
    expect(records[1].type).to.equal('resolve')
  })

  it('readAll returns [] when the file is absent', async () => {
    const store = new FileBrokerPersistence({dataDir})
    expect(await store.readAll()).to.deep.equal([])
  })

  it('readAll tolerates trailing partial / malformed lines', async () => {
    const store = new FileBrokerPersistence({dataDir})
    await store.appendTrack({
      channelId: 'c',
      deliveryId: 'd1',
      memberHandle: '@a',
      permissionRequestId: 'p1',
      projectRoot: '/proj',
      turnId: 't1',
    })
    // Simulate a crash mid-write.
    await fs.appendFile(join(dataDir, 'state', 'pending-permissions.jsonl'), '{"type":"track",inv')
    const records = await store.readAll()
    expect(records).to.have.lengthOf(1)
  })

  it('truncate empties the file (atomic rename)', async () => {
    const store = new FileBrokerPersistence({dataDir})
    await store.appendResolve({permissionRequestId: 'p1'})
    await store.truncate()
    expect(await store.readAll()).to.deep.equal([])
    // file exists (empty), no .tmp leftovers.
    const dirEntries = await fs.readdir(join(dataDir, 'state'))
    const leftover = dirEntries.filter((f) => f.includes('.tmp'))
    expect(leftover).to.deep.equal([])
  })

  it('persists with mode 0600', async () => {
    const store = new FileBrokerPersistence({dataDir})
    await store.appendTrack({
      channelId: 'c',
      deliveryId: 'd1',
      memberHandle: '@a',
      permissionRequestId: 'p1',
      projectRoot: '/proj',
      turnId: 't1',
    })
    const stat = await fs.stat(join(dataDir, 'state', 'pending-permissions.jsonl'))
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).to.equal(0o600)
  })
})

describe('computeLivePending', () => {
  it('drops tracks whose matching resolve appears later in the log', () => {
    const live = computeLivePending([
      {channelId: 'c', deliveryId: 'd', memberHandle: '@a', permissionRequestId: 'p1', projectRoot: '/p', turnId: 't', type: 'track'},
      {channelId: 'c', deliveryId: 'd', memberHandle: '@a', permissionRequestId: 'p2', projectRoot: '/p', turnId: 't', type: 'track'},
      {permissionRequestId: 'p1', type: 'resolve'},
    ])
    expect(live.map((p) => p.permissionRequestId)).to.deep.equal(['p2'])
  })

  it('keeps a track when the matching resolve is absent', () => {
    const live = computeLivePending([
      {channelId: 'c', deliveryId: 'd', memberHandle: '@a', permissionRequestId: 'p1', projectRoot: '/p', turnId: 't', type: 'track'},
    ])
    expect(live).to.have.lengthOf(1)
  })

  it('returns [] when every track has a matching resolve', () => {
    expect(
      computeLivePending([
        {channelId: 'c', deliveryId: 'd', memberHandle: '@a', permissionRequestId: 'p1', projectRoot: '/p', turnId: 't', type: 'track'},
        {permissionRequestId: 'p1', type: 'resolve'},
      ]),
    ).to.deep.equal([])
  })
})
})

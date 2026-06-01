import {expect} from 'chai'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {FileChannelStore} from '../../../../../src/server/infra/channel/channel-store.js'
import {channelPaths} from '../../../../../src/server/infra/channel/storage/channel-paths.js'
import {makeAcpMember} from '../../../../helpers/channel-fixtures.js'

/** Asserts a promise rejects with a message matching `pattern` (no chai-as-promised dependency). */
const assertRejects = async (promise: Promise<unknown>, pattern: RegExp): Promise<void> => {
  let caught: Error | undefined
  try {
    await promise
  } catch (error) {
    caught = error as Error
  }

  expect(caught, 'expected the promise to reject').to.be.instanceOf(Error)
  expect(caught?.message ?? '').to.match(pattern)
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

describe('channel-store (FileChannelStore)', () => {
  let projectRoot: string
  let store: FileChannelStore

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'brv-channel-store-'))
    store = new FileChannelStore({projectRoot})
  })

  afterEach(async () => {
    await rm(projectRoot, {force: true, recursive: true})
  })

  it('createChannel then readChannel round-trips', async () => {
    const created = await store.createChannel({channelId: 'ch1', title: 'Demo'})
    expect(created.channelId).to.equal('ch1')
    expect(created.title).to.equal('Demo')
    expect(created.memberCount).to.equal(0)
    expect(created.members).to.deep.equal([])
    expect(created.createdAt).to.equal(created.updatedAt)

    expect(await store.readChannel('ch1')).to.deep.equal(created)
  })

  it('readChannel returns undefined for an unknown channel', async () => {
    expect(await store.readChannel('nope')).to.equal(undefined)
  })

  it('persists full member records on disk but projects summaries in readChannel', async () => {
    await store.createChannel({channelId: 'ch1'})
    await store.addMember({channelId: 'ch1', member: makeAcpMember()})

    const raw = await readFile(channelPaths.metaFile(projectRoot, 'ch1'), 'utf8')
    const doc = JSON.parse(raw)
    expect(doc.members[0]).to.include({agentName: 'Alice', driverClass: 'A', handle: '@alice'})
    expect(doc.members[0].invocation).to.deep.equal({args: [], command: 'acp-agent', cwd: '/tmp/proj'})

    const channel = await store.readChannel('ch1')
    expect(channel?.memberCount).to.equal(1)
    expect(channel?.members).to.deep.equal([
      {capabilities: ['fs'], displayName: 'Alice', handle: '@alice', memberKind: 'acp-agent', status: 'idle'},
    ])
  })

  it('createChannel rejects when the channelId already exists', async () => {
    await store.createChannel({channelId: 'ch1'})
    await assertRejects(store.createChannel({channelId: 'ch1'}), /already exists/i)
  })

  it('createChannel called concurrently has exactly one winner', async () => {
    const results = await Promise.allSettled([
      store.createChannel({channelId: 'ch1'}),
      store.createChannel({channelId: 'ch1'}),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).to.have.lengthOf(1)
    expect(rejected).to.have.lengthOf(1)
  })

  it('listChannels returns created channels sorted and skips corrupt / meta-less dirs', async () => {
    await store.createChannel({channelId: 'ch2'})
    await store.createChannel({channelId: 'ch1'})
    await mkdir(channelPaths.channelDir(projectRoot, 'chBad'), {recursive: true})
    await writeFile(channelPaths.metaFile(projectRoot, 'chBad'), 'not json', 'utf8')
    await mkdir(channelPaths.channelDir(projectRoot, 'chNoMeta'), {recursive: true})

    const channels = await store.listChannels()
    expect(channels.map((c) => c.channelId)).to.deep.equal(['ch1', 'ch2'])
  })

  it('listChannels returns [] when no channel-history root exists', async () => {
    expect(await store.listChannels()).to.deep.equal([])
  })

  it('listChannels includes archived channels', async () => {
    await store.createChannel({channelId: 'ch1'})
    await store.updateChannel({archivedAt: '2026-05-25T12:00:00.000Z', channelId: 'ch1'})

    const channels = await store.listChannels()
    expect(channels.map((c) => c.channelId)).to.deep.equal(['ch1'])
  })

  it('addMember adds a member and refreshes updatedAt', async () => {
    const created = await store.createChannel({channelId: 'ch1'})
    await delay(10)
    await store.addMember({channelId: 'ch1', member: makeAcpMember()})

    const channel = await store.readChannel('ch1')
    expect(channel?.memberCount).to.equal(1)
    expect(new Date(channel?.updatedAt ?? 0).getTime()).to.be.greaterThan(
      new Date(created.createdAt).getTime(),
    )
  })

  it('addMember on a missing channel rejects', async () => {
    await assertRejects(store.addMember({channelId: 'nope', member: makeAcpMember()}), /not found/i)
  })

  it('addMember upserts by handle without double-counting', async () => {
    await store.createChannel({channelId: 'ch1'})
    await store.addMember({channelId: 'ch1', member: makeAcpMember({status: 'idle'})})
    await store.addMember({channelId: 'ch1', member: makeAcpMember({status: 'thinking'})})

    const members = await store.listMembers('ch1')
    expect(members).to.have.lengthOf(1)
    expect(members[0]).to.include({handle: '@alice', status: 'thinking'})
  })

  it('concurrent addMember of two handles keeps both', async () => {
    await store.createChannel({channelId: 'ch1'})
    await Promise.all([
      store.addMember({channelId: 'ch1', member: makeAcpMember({handle: '@a'})}),
      store.addMember({channelId: 'ch1', member: makeAcpMember({handle: '@b'})}),
    ])

    const members = await store.listMembers('ch1')
    expect(members.map((m) => m.handle).sort()).to.deep.equal(['@a', '@b'])
    expect((await store.readChannel('ch1'))?.memberCount).to.equal(2)
  })

  it('listMembers returns full ChannelMember records', async () => {
    await store.createChannel({channelId: 'ch1'})
    const member = makeAcpMember()
    await store.addMember({channelId: 'ch1', member})

    expect(await store.listMembers('ch1')).to.deep.equal([member])
  })

  it('removeMember removes by handle and is a no-op (no write) when absent', async () => {
    await store.createChannel({channelId: 'ch1'})
    await store.addMember({channelId: 'ch1', member: makeAcpMember({handle: '@a'})})
    await store.addMember({channelId: 'ch1', member: makeAcpMember({handle: '@b'})})

    await store.removeMember({channelId: 'ch1', memberHandle: '@a'})
    expect((await store.listMembers('ch1')).map((m) => m.handle)).to.deep.equal(['@b'])

    const before = (await store.readChannel('ch1'))?.updatedAt
    await delay(10)
    await store.removeMember({channelId: 'ch1', memberHandle: '@a'})
    expect((await store.readChannel('ch1'))?.updatedAt).to.equal(before)
  })

  it('removeMember on a missing channel is a no-op', async () => {
    await store.removeMember({channelId: 'nope', memberHandle: '@x'})
  })

  it('updateChannel applies a title/settings patch and keeps createdAt', async () => {
    const created = await store.createChannel({channelId: 'ch1'})
    await delay(10)
    const updated = await store.updateChannel({
      channelId: 'ch1',
      settings: {maxParallelAgents: 3},
      title: 'Renamed',
    })

    expect(updated.title).to.equal('Renamed')
    expect(updated.settings).to.deep.equal({maxParallelAgents: 3})
    expect(updated.createdAt).to.equal(created.createdAt)
    expect(new Date(updated.updatedAt).getTime()).to.be.greaterThan(new Date(created.createdAt).getTime())
  })

  it('updateChannel rejects when the channel is missing', async () => {
    await assertRejects(store.updateChannel({channelId: 'nope', title: 'x'}), /not found/i)
  })

  it('writes to the configured projectRoot (two stores stay isolated)', async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), 'brv-channel-store-other-'))
    try {
      const other = new FileChannelStore({projectRoot: otherRoot})
      await store.createChannel({channelId: 'ch1', title: 'here'})
      await other.createChannel({channelId: 'ch1', title: 'there'})

      expect((await store.readChannel('ch1'))?.title).to.equal('here')
      expect((await other.readChannel('ch1'))?.title).to.equal('there')
    } finally {
      await rm(otherRoot, {force: true, recursive: true})
    }
  })
})

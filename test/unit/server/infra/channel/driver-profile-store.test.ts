import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {AgentDriverProfile} from '../../../../../src/shared/types/index.js'

import {FileDriverProfileStore} from '../../../../../src/server/infra/channel/driver-profile-store.js'

const makeProfile = (overrides: Partial<AgentDriverProfile> = {}): AgentDriverProfile => ({
  capabilities: [],
  detectedAcpVersion: '1',
  displayName: 'Mock',
  driverClass: 'B',
  invocation: {args: ['mock-acp.js'], command: 'node', cwd: '/tmp'},
  name: 'mock',
  probedAt: '2026-05-12T08:00:00.000Z',
  ...overrides,
})

describe('FileDriverProfileStore', () => {
  let dataDir: string
  let store: FileDriverProfileStore

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(join(tmpdir(), 'brv-profile-store-'))
    store = new FileDriverProfileStore({dataDir})
  })

  afterEach(async () => {
    await fs.rm(dataDir, {force: true, recursive: true})
  })

  it('upsert then get round-trips the profile', async () => {
    await store.upsert(makeProfile())
    const got = await store.get('mock')
    expect(got?.name).to.equal('mock')
    expect(got?.driverClass).to.equal('B')
    expect(got?.invocation.command).to.equal('node')
  })

  it('get returns undefined for an unknown profile', async () => {
    expect(await store.get('nope')).to.equal(undefined)
  })

  it('upsert replaces an existing profile by name (last-write-wins)', async () => {
    await store.upsert(makeProfile({displayName: 'First'}))
    await store.upsert(makeProfile({displayName: 'Second'}))
    const got = await store.get('mock')
    expect(got?.displayName).to.equal('Second')
    expect(await store.list()).to.have.length(1)
  })

  it('list returns profiles sorted by name', async () => {
    await store.upsert(makeProfile({name: 'zeta'}))
    await store.upsert(makeProfile({name: 'alpha'}))
    const names = (await store.list()).map((p) => p.name)
    expect(names).to.deep.equal(['alpha', 'zeta'])
  })

  it('remove deletes a profile and is idempotent', async () => {
    await store.upsert(makeProfile())
    expect(await store.remove('mock')).to.equal(true)
    expect(await store.get('mock')).to.equal(undefined)
    expect(await store.remove('mock')).to.equal(false)
  })

  it('treats a corrupt registry file as empty', async () => {
    await fs.mkdir(join(dataDir, 'state'), {recursive: true})
    await fs.writeFile(join(dataDir, 'state', 'agent-driver-profiles.json'), '{ not json', 'utf8')
    expect(await store.list()).to.deep.equal([])
    // The next upsert overwrites the corruption with a valid document.
    await store.upsert(makeProfile())
    expect(await store.get('mock')).to.not.equal(undefined)
  })

  it('persists the registry file with mode 0600', async () => {
    await store.upsert(makeProfile())
    const stat = await fs.stat(join(dataDir, 'state', 'agent-driver-profiles.json'))
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).to.equal(0o600)
  })
})

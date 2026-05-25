import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {AgentDriverProfile} from '../../../../../src/shared/types/channel.js'

import {FileDriverProfileStore} from '../../../../../src/server/infra/channel/driver-profile-store.js'

// Slice 3.0 — `FileDriverProfileStore` persists driver profiles under
// `$BRV_DATA_DIR/state/agent-driver-profiles.json`. Atomic-rename writes;
// mode 0600; `[]` when file is missing; `last write wins` on duplicate names.

const make = (overrides: Partial<AgentDriverProfile> = {}): AgentDriverProfile => ({
  capabilities: [],
  displayName: 'Mock',
  driverClass: 'C-prime',
  invocation: {args: ['mock-acp.js'], command: 'node', cwd: '/tmp'},
  name: 'mock',
  ...overrides,
})

describe('FileDriverProfileStore', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(join(tmpdir(), 'brv-profile-store-'))
  })

  afterEach(async () => {
    await fs.rm(dataDir, {force: true, recursive: true})
  })

  const path = (): string => join(dataDir, 'state', 'agent-driver-profiles.json')

  it('list returns [] when the file is missing', async () => {
    const store = new FileDriverProfileStore({dataDir})
    expect(await store.list()).to.deep.equal([])
  })

  it('upsert + list round-trips a single profile', async () => {
    const store = new FileDriverProfileStore({dataDir})
    const profile = make({capabilities: ['embeddedContext'], detectedAcpVersion: '1', displayName: 'Kimi', driverClass: 'A', name: 'kimi'})
    await store.upsert(profile)
    const list = await store.list()
    expect(list).to.deep.equal([profile])
  })

  it('upsert replaces an existing profile by name (last write wins)', async () => {
    const store = new FileDriverProfileStore({dataDir})
    await store.upsert(make({displayName: 'Mock v1', name: 'mock'}))
    await store.upsert(make({displayName: 'Mock v2', name: 'mock'}))
    const list = await store.list()
    expect(list).to.have.lengthOf(1)
    expect(list[0].displayName).to.equal('Mock v2')
  })

  it('get returns the profile by name or undefined', async () => {
    const store = new FileDriverProfileStore({dataDir})
    await store.upsert(make({name: 'kimi'}))
    expect((await store.get('kimi'))?.name).to.equal('kimi')
    expect(await store.get('ghost')).to.equal(undefined)
  })

  it('remove deletes a profile by name and returns true', async () => {
    const store = new FileDriverProfileStore({dataDir})
    await store.upsert(make({name: 'mock'}))
    expect(await store.remove('mock')).to.equal(true)
    expect(await store.get('mock')).to.equal(undefined)
  })

  it('remove is idempotent (returns false when the profile is absent)', async () => {
    const store = new FileDriverProfileStore({dataDir})
    expect(await store.remove('ghost')).to.equal(false)
  })

  it('persists the file with mode 0600', async () => {
    const store = new FileDriverProfileStore({dataDir})
    await store.upsert(make({name: 'mock'}))
    const stat = await fs.stat(path())
    // mode is a bitmask; lower 9 bits are permission bits. 0o600 = owner rw, no group/other.
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).to.equal(0o600)
  })

  it('preserves the file across an upsert/remove cycle (atomic rename, no .tmp left behind)', async () => {
    const store = new FileDriverProfileStore({dataDir})
    await store.upsert(make({name: 'a'}))
    await store.upsert(make({name: 'b'}))
    await store.remove('a')
    const stateEntries = await fs.readdir(join(dataDir, 'state'))
    const tmpLeftover = stateEntries.filter((f) => f.includes('.tmp'))
    expect(tmpLeftover).to.deep.equal([])
    expect((await store.list()).map((p) => p.name)).to.deep.equal(['b'])
  })

  it('tolerates a corrupt registry file by treating it as empty', async () => {
    await fs.mkdir(join(dataDir, 'state'), {recursive: true})
    await fs.writeFile(path(), 'not json at all', 'utf8')
    const store = new FileDriverProfileStore({dataDir})
    expect(await store.list()).to.deep.equal([])
  })
})

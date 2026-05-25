import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {ChannelStore} from '../../../../../src/server/infra/channel/channel-store.js'
import {ChannelDoctorService} from '../../../../../src/server/infra/channel/doctor-service.js'
import {FileDriverProfileStore} from '../../../../../src/server/infra/channel/driver-profile-store.js'
import {AcpDriverPool} from '../../../../../src/server/infra/channel/drivers/acp-driver-pool.js'
import {PermissionBroker} from '../../../../../src/server/infra/channel/drivers/permission-broker.js'
import {FileProfileMetadataStore} from '../../../../../src/server/infra/channel/profile-metadata-store.js'
import {ChannelEventsWriter} from '../../../../../src/server/infra/channel/storage/events-writer.js'
import {ChannelSnapshotWriter} from '../../../../../src/server/infra/channel/storage/snapshot-writer.js'
import {ChannelTreeReader} from '../../../../../src/server/infra/channel/storage/tree-reader.js'
import {ChannelWriteSerializer} from '../../../../../src/server/infra/channel/storage/write-serializer.js'

// Slice 4.2 — doctor emits KIMI_AUTH_STALE when the profile-metadata store
// records `lastProbeError: 'AUTH_REQUIRED'`. The diagnostic is sourced from
// the local-only metadata file — NOT from `AgentDriverProfile`, which
// remains untouched by this slice.

describe('ChannelDoctorService — KIMI_AUTH_STALE (Slice 4.2)', () => {
  let dataDir: string
  let profileStore: FileDriverProfileStore
  let metadataStore: FileProfileMetadataStore
  let doctor: ChannelDoctorService

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(join(tmpdir(), 'brv-doctor-auth-'))
    const serializer = new ChannelWriteSerializer()
    profileStore = new FileDriverProfileStore({dataDir})
    metadataStore = new FileProfileMetadataStore({dataDir})
    doctor = new ChannelDoctorService({
      broker: new PermissionBroker(),
      clock: () => new Date('2026-05-12T10:00:00.000Z'),
      pool: new AcpDriverPool(),
      profileMetadataStore: metadataStore,
      profileStore,
      store: new ChannelStore({
        eventsWriter: new ChannelEventsWriter({serializer}),
        snapshotWriter: new ChannelSnapshotWriter({eventsWriter: new ChannelEventsWriter({serializer: new ChannelWriteSerializer()})}),
        treeReader: new ChannelTreeReader(),
        writeSerializer: serializer,
      }),
    })
  })

  afterEach(async () => {
    await fs.rm(dataDir, {force: true, recursive: true})
  })

  it('emits KIMI_AUTH_STALE when lastProbeError === AUTH_REQUIRED', async () => {
    await profileStore.upsert({
      capabilities: ['embeddedContext'],
      detectedAcpVersion: '1',
      displayName: 'Kimi',
      driverClass: 'A',
      invocation: {args: ['acp'], command: 'kimi', cwd: '/tmp'},
      name: 'kimi',
      probedAt: '2026-05-01T00:00:00.000Z',
    })
    await metadataStore.setLastProbeError({
      at: '2026-05-12T09:00:00.000Z',
      error: 'AUTH_REQUIRED',
      name: 'kimi',
    })

    const {diagnostics} = await doctor.run({profileName: 'kimi', projectRoot: '/tmp'})
    const stale = diagnostics.find((d) => d.code === 'KIMI_AUTH_STALE')
    expect(stale, 'expected a KIMI_AUTH_STALE diagnostic').to.not.equal(undefined)
    expect(stale?.severity).to.equal('warning')
    expect(stale?.message).to.match(/AUTH_REQUIRED|login/)
  })

  it('does not emit KIMI_AUTH_STALE when no metadata record exists', async () => {
    await profileStore.upsert({
      capabilities: ['embeddedContext'],
      detectedAcpVersion: '1',
      displayName: 'Kimi',
      driverClass: 'A',
      invocation: {args: ['acp'], command: 'kimi', cwd: '/tmp'},
      name: 'kimi',
      probedAt: '2026-05-12T09:00:00.000Z',
    })

    const {diagnostics} = await doctor.run({profileName: 'kimi', projectRoot: '/tmp'})
    expect(diagnostics.some((d) => d.code === 'KIMI_AUTH_STALE')).to.equal(false)
  })

  it('does not look at AgentDriverProfile for auth state (wire spec untouched)', async () => {
    await profileStore.upsert({
      capabilities: ['embeddedContext'],
      detectedAcpVersion: '1',
      displayName: 'Kimi',
      driverClass: 'A',
      invocation: {args: ['acp'], command: 'kimi', cwd: '/tmp'},
      name: 'kimi',
      probedAt: '2026-05-12T09:00:00.000Z',
    })
    const persisted = await profileStore.get('kimi')
    // No auth-state field on AgentDriverProfile.
    expect(persisted).to.not.have.property('lastProbeError')
    expect(persisted).to.not.have.property('authRequired')
  })
})

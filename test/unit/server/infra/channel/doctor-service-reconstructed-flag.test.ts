
import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {ChannelStore} from '../../../../../src/server/infra/channel/channel-store.js'
import {ChannelDoctorService} from '../../../../../src/server/infra/channel/doctor-service.js'
import {FileDriverProfileStore} from '../../../../../src/server/infra/channel/driver-profile-store.js'
import {AcpDriverPool} from '../../../../../src/server/infra/channel/drivers/acp-driver-pool.js'
import {PermissionBroker} from '../../../../../src/server/infra/channel/drivers/permission-broker.js'
import {ChannelEventsWriter} from '../../../../../src/server/infra/channel/storage/events-writer.js'
import {ChannelSnapshotWriter} from '../../../../../src/server/infra/channel/storage/snapshot-writer.js'
import {ChannelTreeReader} from '../../../../../src/server/infra/channel/storage/tree-reader.js'
import {ChannelWriteSerializer} from '../../../../../src/server/infra/channel/storage/write-serializer.js'
import {makeTempContextTree} from '../../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../../helpers/temp-dir.js'

// Phase 9.5.10 Fix B — doctor surface for reconstructed channels.
//
// When meta.reconstructionStatus === 'reconstructed-from-history', doctor
// emits DOCTOR_RECONSTRUCTED_FROM_HISTORY as a warning with the inferred
// handles list and a recovery hint to re-invite each handle.

describe('ChannelDoctorService — DOCTOR_RECONSTRUCTED_FROM_HISTORY (Phase 9.5.10)', () => {
  let projectRoot: string
  let dataDir: string
  let store: ChannelStore
  let doctor: ChannelDoctorService

  beforeEach(async () => {
    projectRoot = await makeTempContextTree()
    dataDir = await fs.mkdtemp(join(tmpdir(), 'brv-doctor-rec-'))
    const serializer = new ChannelWriteSerializer()
    store = new ChannelStore({
      eventsWriter: new ChannelEventsWriter({serializer}),
      snapshotWriter: new ChannelSnapshotWriter({
        eventsWriter: new ChannelEventsWriter({serializer: new ChannelWriteSerializer()}),
      }),
      treeReader: new ChannelTreeReader(),
      writeSerializer: serializer,
    })
    doctor = new ChannelDoctorService({
      broker: new PermissionBroker(),
      clock: () => new Date('2026-05-25T10:00:00.000Z'),
      pool: new AcpDriverPool(),
      profileStore: new FileDriverProfileStore({dataDir}),
      store,
    })
  })

  afterEach(async () => {
    await removeTempDir(projectRoot)
    await fs.rm(dataDir, {force: true, recursive: true})
  })

  it('emits DOCTOR_RECONSTRUCTED_FROM_HISTORY (warning) when meta carries the reconstructionStatus flag', async () => {
    await store.reconstructIfMissing({
      meta: {
        channelId: 'ch-rec',
        createdAt: '2026-05-24T10:00:00.000Z',
        inferredHandles: ['@alice', '@bob'],
        members: [],
        reconstructedAt: '2026-05-25T00:00:00.000Z',
        reconstructionStatus: 'reconstructed-from-history',
        updatedAt: '2026-05-25T00:00:00.000Z',
      },
      projectRoot,
    })

    const {diagnostics} = await doctor.run({channelId: 'ch-rec', projectRoot})
    const found = diagnostics.find((d) => d.code === 'DOCTOR_RECONSTRUCTED_FROM_HISTORY')
    expect(found).to.not.equal(undefined)
    expect(found?.severity).to.equal('warning')
    // Recovery hint must mention each inferred handle so the operator
    // knows whom to re-invite.
    expect(found?.message).to.include('@alice')
    expect(found?.message).to.include('@bob')
    expect(found?.message.toLowerCase()).to.include('invite')
  })

  it('does NOT emit DOCTOR_RECONSTRUCTED_FROM_HISTORY for healthy channels', async () => {
    await store.createChannel({
      meta: {
        channelId: 'ch-healthy',
        createdAt: '2026-05-24T10:00:00.000Z',
        members: [],
        updatedAt: '2026-05-24T10:00:00.000Z',
      },
      projectRoot,
    })

    const {diagnostics} = await doctor.run({channelId: 'ch-healthy', projectRoot})
    expect(diagnostics.some((d) => d.code === 'DOCTOR_RECONSTRUCTED_FROM_HISTORY')).to.equal(false)
  })
})

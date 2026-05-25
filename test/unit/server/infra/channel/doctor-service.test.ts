import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {AgentDriverProfile} from '../../../../../src/shared/types/channel.js'

import {ChannelStore} from '../../../../../src/server/infra/channel/channel-store.js'
import {ChannelDoctorService} from '../../../../../src/server/infra/channel/doctor-service.js'
import {FileDriverProfileStore} from '../../../../../src/server/infra/channel/driver-profile-store.js'
import {AcpDriverPool} from '../../../../../src/server/infra/channel/drivers/acp-driver-pool.js'
import {MockAcpDriver} from '../../../../../src/server/infra/channel/drivers/mock-driver.js'
import {PermissionBroker} from '../../../../../src/server/infra/channel/drivers/permission-broker.js'
import {ChannelEventsWriter} from '../../../../../src/server/infra/channel/storage/events-writer.js'
import {ChannelSnapshotWriter} from '../../../../../src/server/infra/channel/storage/snapshot-writer.js'
import {ChannelTreeReader} from '../../../../../src/server/infra/channel/storage/tree-reader.js'
import {ChannelWriteSerializer} from '../../../../../src/server/infra/channel/storage/write-serializer.js'
import {makeTempContextTree} from '../../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../../helpers/temp-dir.js'

// Slice 3.3 — doctor service. Aggregates pool / broker / profile state +
// channel/event state into a structured DoctorDiagnostic[].

describe('ChannelDoctorService', () => {
  let projectRoot: string
  let dataDir: string
  let store: ChannelStore
  let pool: AcpDriverPool
  let broker: PermissionBroker
  let profileStore: FileDriverProfileStore
  let doctor: ChannelDoctorService

  beforeEach(async () => {
    projectRoot = await makeTempContextTree()
    dataDir = await fs.mkdtemp(join(tmpdir(), 'brv-doctor-'))
    const serializer = new ChannelWriteSerializer()
    store = new ChannelStore({
      eventsWriter: new ChannelEventsWriter({serializer}),
      snapshotWriter: new ChannelSnapshotWriter({eventsWriter: new ChannelEventsWriter({serializer: new ChannelWriteSerializer()})}),
      treeReader: new ChannelTreeReader(),
      writeSerializer: serializer,
    })
    pool = new AcpDriverPool()
    broker = new PermissionBroker()
    profileStore = new FileDriverProfileStore({dataDir})
    doctor = new ChannelDoctorService({
      broker,
      clock: () => new Date('2026-05-12T10:00:00.000Z'),
      pool,
      profileStore,
      store,
    })
  })

  afterEach(async () => {
    await removeTempDir(projectRoot)
    await fs.rm(dataDir, {force: true, recursive: true})
  })

  it('returns DOCTOR_CHANNEL_NOT_FOUND when the channelId is unknown', async () => {
    const {diagnostics} = await doctor.run({channelId: 'ghost', projectRoot})
    expect(diagnostics.some((d) => d.code === 'DOCTOR_CHANNEL_NOT_FOUND' && d.severity === 'error')).to.equal(true)
  })

  it('returns DOCTOR_NO_RECENT_TURN for a freshly-created channel with no turns', async () => {
    await store.createChannel({
      meta: {
        channelId: 'pi-test',
        createdAt: '2026-04-01T00:00:00.000Z',
        members: [],
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
      projectRoot,
    })
    const {diagnostics} = await doctor.run({channelId: 'pi-test', projectRoot})
    expect(diagnostics.some((d) => d.code === 'DOCTOR_NO_RECENT_TURN' && d.severity === 'info')).to.equal(true)
  })

  it('returns DOCTOR_MEMBER_IDLE for each acp-agent member with no in-flight delivery', async () => {
    await store.createChannel({
      meta: {
        channelId: 'pi-test',
        createdAt: '2026-05-12T09:00:00.000Z',
        members: [
          {
            acpVersion: '1',
            agentName: '@mock',
            capabilities: [],
            driverClass: 'C-prime',
            handle: '@mock',
            invocation: {args: [], command: 'noop', cwd: '/tmp'},
            joinedAt: '2026-05-12T09:00:00.000Z',
            memberKind: 'acp-agent',
            status: 'idle',
          },
        ],
        updatedAt: '2026-05-12T09:00:00.000Z',
      },
      projectRoot,
    })

    const {diagnostics} = await doctor.run({channelId: 'pi-test', projectRoot})
    const idle = diagnostics.filter((d) => d.code === 'DOCTOR_MEMBER_IDLE')
    expect(idle).to.have.lengthOf(1)
    expect(idle[0].severity).to.equal('info')
  })

  it('returns DOCTOR_DRIVER_NOT_REGISTERED when the member has no pool driver and DOCTOR_PERMISSION_PENDING when the broker is tracking one', async () => {
    await store.createChannel({
      meta: {
        channelId: 'pi-test',
        createdAt: '2026-05-12T09:00:00.000Z',
        members: [
          {
            acpVersion: '1',
            agentName: '@mock',
            capabilities: [],
            driverClass: 'C-prime',
            handle: '@mock',
            invocation: {args: [], command: 'noop', cwd: '/tmp'},
            joinedAt: '2026-05-12T09:00:00.000Z',
            memberKind: 'acp-agent',
            status: 'idle',
          },
        ],
        updatedAt: '2026-05-12T09:00:00.000Z',
      },
      projectRoot,
    })

    // No driver registered for @mock; broker has a pending permission.
    const driver = new MockAcpDriver({events: [], handle: '@mock'})
    broker.track({channelId: 'pi-test', deliveryId: 'd1', driver, permissionRequestId: 'p1', turnId: 't1'})

    const {diagnostics} = await doctor.run({channelId: 'pi-test', projectRoot})
    expect(diagnostics.some((d) => d.code === 'DOCTOR_DRIVER_NOT_REGISTERED' && d.severity === 'warning')).to.equal(true)
    expect(diagnostics.some((d) => d.code === 'DOCTOR_PERMISSION_PENDING' && d.severity === 'warning')).to.equal(true)
  })

  it('returns DOCTOR_PROFILE_STALE when the profile was probed more than 7 days ago', async () => {
    const stale: AgentDriverProfile = {
      capabilities: [],
      displayName: 'Mock',
      driverClass: 'C-prime',
      invocation: {args: ['mock-acp.js'], command: 'node', cwd: '/tmp'},
      name: 'mock',
      probedAt: '2026-05-01T00:00:00.000Z', // 11 days before the clock
    }
    await profileStore.upsert(stale)

    const {diagnostics} = await doctor.run({profileName: 'mock', projectRoot})
    expect(diagnostics.some((d) => d.code === 'DOCTOR_PROFILE_STALE' && d.severity === 'warning')).to.equal(true)
  })

  it('does NOT return DOCTOR_PROFILE_STALE when probedAt is within the freshness window', async () => {
    const fresh: AgentDriverProfile = {
      capabilities: [],
      displayName: 'Mock',
      driverClass: 'C-prime',
      invocation: {args: ['mock-acp.js'], command: 'node', cwd: '/tmp'},
      name: 'mock',
      probedAt: '2026-05-11T12:00:00.000Z', // < 24h before the clock
    }
    await profileStore.upsert(fresh)

    const {diagnostics} = await doctor.run({profileName: 'mock', projectRoot})
    expect(diagnostics.some((d) => d.code === 'DOCTOR_PROFILE_STALE')).to.equal(false)
  })
})

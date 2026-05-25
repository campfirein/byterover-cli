import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {IAcpDriver} from '../../../../../src/server/core/interfaces/channel/i-acp-driver.js'

import {FileDriverProfileStore} from '../../../../../src/server/infra/channel/driver-profile-store.js'
import {MockAcpDriver} from '../../../../../src/server/infra/channel/drivers/mock-driver.js'
import {ChannelOnboardService} from '../../../../../src/server/infra/channel/onboard-service.js'

// Slice 3.2 — onboard service. Spawns a candidate driver, runs initialize
// (start), probes session/new, classifies, persists. Failure does NOT
// persist; the diagnostics surface the failed step.

describe('ChannelOnboardService', () => {
  let dataDir: string
  let store: FileDriverProfileStore
  let stoppedDrivers: IAcpDriver[]

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(join(tmpdir(), 'brv-onboard-'))
    store = new FileDriverProfileStore({dataDir})
    stoppedDrivers = []
  })

  afterEach(async () => {
    await fs.rm(dataDir, {force: true, recursive: true})
  })

  const makeService = (driverFactory: () => IAcpDriver): ChannelOnboardService =>
    new ChannelOnboardService({
      clock: () => new Date('2026-05-12T08:00:00.000Z'),
      driverFactory,
      store,
    })

  const trackStop = (driver: IAcpDriver): IAcpDriver => {
    const original = driver.stop.bind(driver)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(driver as any).stop = async () => {
      stoppedDrivers.push(driver)
      await original()
    }

    return driver
  }

  it('class-A: persists the profile + returns no error diagnostics', async () => {
    const driver = trackStop(
      new MockAcpDriver({
        acpInitialize: {
          agentCapabilities: {
            promptCapabilities: {embeddedContext: true, image: true},
          },
        },
        events: [],
        handle: '@kimi',
      }),
    )
    const svc = makeService(() => driver)
    const {diagnostics, profile} = await svc.onboard({
      displayName: 'Kimi',
      invocation: {args: [], command: 'kimi', cwd: '/tmp'},
      profileName: 'kimi',
    })

    expect(profile.name).to.equal('kimi')
    expect(profile.driverClass).to.equal('A')
    expect(profile.probedAt).to.equal('2026-05-12T08:00:00.000Z')
    expect(diagnostics.filter((d) => d.severity === 'error')).to.deep.equal([])

    const persisted = await store.get('kimi')
    expect(persisted?.driverClass).to.equal('A')

    // Driver was stopped after probing.
    expect(stoppedDrivers).to.include(driver)
  })

  it('class-B: baseline ACP succeeds, no embeddedContext → classified as B', async () => {
    const driver = trackStop(
      new MockAcpDriver({
        acpInitialize: {agentCapabilities: {promptCapabilities: {embeddedContext: false}}},
        events: [],
        handle: '@plain',
      }),
    )
    const svc = makeService(() => driver)
    const {profile} = await svc.onboard({
      displayName: 'Plain',
      invocation: {args: [], command: 'plain', cwd: '/tmp'},
      profileName: 'plain',
    })
    expect(profile.driverClass).to.equal('B')
  })

  it('session/new failure → C-prime + error diagnostic + profile NOT persisted', async () => {
    const driver = trackStop(
      new MockAcpDriver({
        acpInitialize: {agentCapabilities: {promptCapabilities: {embeddedContext: true, image: true}}},
        events: [],
        handle: '@flaky',
        probeSessionResult: false,
      }),
    )
    const svc = makeService(() => driver)
    let thrown: unknown
    try {
      await svc.onboard({
        displayName: 'Flaky',
        invocation: {args: [], command: 'flaky', cwd: '/tmp'},
        profileName: 'flaky',
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown, 'expected onboard to throw on session/new failure').to.not.equal(undefined)
    expect((thrown as Error).message).to.match(/session\/new|ACP_SESSION_FAILED|driver class/i)

    // Profile MUST NOT be persisted.
    expect(await store.get('flaky')).to.equal(undefined)
    // Driver was still stopped (we don't leak subprocess agents on failure).
    expect(stoppedDrivers).to.include(driver)
  })

  it('initialize handshake failure → no persistence + error diagnostic', async () => {
    const driver = trackStop(new MockAcpDriver({events: [], handle: '@bad'}))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(driver as any).start = async () => {
      throw new Error('mock: initialize refused')
    }

    const svc = makeService(() => driver)
    let thrown: unknown
    try {
      await svc.onboard({
        displayName: 'Bad',
        invocation: {args: [], command: 'bad', cwd: '/tmp'},
        profileName: 'bad',
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).to.not.equal(undefined)
    expect(await store.get('bad')).to.equal(undefined)
    expect(stoppedDrivers).to.include(driver)
  })

  it('explicit _meta.brv.driverClass overrides automatic classification', async () => {
    const driver = trackStop(
      new MockAcpDriver({
        acpInitialize: {
          _meta: {'brv.driverClass': 'C-prime'},
          agentCapabilities: {promptCapabilities: {embeddedContext: true, image: true}},
        },
        events: [],
        handle: '@mock',
      }),
    )
    const svc = makeService(() => driver)
    const {profile} = await svc.onboard({
      displayName: 'Mock',
      invocation: {args: ['mock-acp.js'], command: 'node', cwd: '/tmp'},
      profileName: 'mock',
    })
    expect(profile.driverClass).to.equal('C-prime')
  })
})

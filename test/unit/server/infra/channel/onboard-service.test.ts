import {expect} from 'chai'

import type {IDriverProfileStore} from '../../../../../src/server/core/interfaces/channel/i-driver-profile-store.js'
import type {AcpInitializeSnapshot} from '../../../../../src/server/infra/channel/drivers/acp-driver.js'
import type {IAcpProbeDriver} from '../../../../../src/server/infra/channel/onboard-service.js'
import type {AgentDriverProfile,AgentDriverProfileInvocation} from '../../../../../src/shared/types/index.js'

import {ChannelOnboardService} from '../../../../../src/server/infra/channel/onboard-service.js'

class InMemoryProfileStore implements IDriverProfileStore {
  public readonly byName = new Map<string, AgentDriverProfile>()

  async get(name: string): Promise<AgentDriverProfile | undefined> {
    return this.byName.get(name)
  }

  async list(): Promise<AgentDriverProfile[]> {
    return [...this.byName.values()]
  }

  async remove(name: string): Promise<boolean> {
    return this.byName.delete(name)
  }

  async upsert(profile: AgentDriverProfile): Promise<void> {
    this.byName.set(profile.name, profile)
  }
}

type FakeDriverOptions = {
  acpInitialize?: AcpInitializeSnapshot
  probeSessionResult?: boolean
  protocolVersion?: number
  startError?: Error
}

class FakeProbeDriver implements IAcpProbeDriver {
  public acpInitialize: AcpInitializeSnapshot | undefined
  public protocolVersion: number | undefined
  public stopped = false
  private readonly options: FakeDriverOptions

  public constructor(options: FakeDriverOptions) {
    this.options = options
    this.acpInitialize = options.acpInitialize
    this.protocolVersion = options.protocolVersion
  }

  async probeSession(): Promise<boolean> {
    return this.options.probeSessionResult ?? true
  }

  async start(): Promise<void> {
    if (this.options.startError !== undefined) throw this.options.startError
  }

  async stop(): Promise<void> {
    this.stopped = true
  }
}

const INVOCATION: AgentDriverProfileInvocation = {args: ['mock-acp.js'], command: 'node', cwd: '/tmp'}

describe('ChannelOnboardService', () => {
  let store: InMemoryProfileStore
  let lastDriver: FakeProbeDriver | undefined

  const makeService = (options: FakeDriverOptions): ChannelOnboardService => {
    store = new InMemoryProfileStore()
    lastDriver = undefined
    return new ChannelOnboardService({
      clock: () => new Date('2026-06-02T08:00:00.000Z'),
      driverFactory() {
        lastDriver = new FakeProbeDriver(options)
        return lastDriver
      },
      store,
    })
  }

  it('class-A: persists the profile and returns no error diagnostics', async () => {
    const svc = makeService({
      acpInitialize: {agentCapabilities: {promptCapabilities: {embeddedContext: true, image: true}}},
      protocolVersion: 1,
    })
    const {diagnostics, profile} = await svc.onboard({displayName: 'Kimi', invocation: INVOCATION, profileName: 'kimi'})

    expect(profile.name).to.equal('kimi')
    expect(profile.driverClass).to.equal('A')
    expect(profile.detectedAcpVersion).to.equal('1')
    expect(profile.probedAt).to.equal('2026-06-02T08:00:00.000Z')
    expect(diagnostics.filter((d) => d.severity === 'error')).to.deep.equal([])
    expect((await store.get('kimi'))?.driverClass).to.equal('A')
    expect(lastDriver?.stopped).to.equal(true)
  })

  it('class-B: baseline ACP with no embeddedContext is classified B', async () => {
    const svc = makeService({acpInitialize: {agentCapabilities: {promptCapabilities: {embeddedContext: false}}}})
    const {profile} = await svc.onboard({displayName: 'Mock', invocation: INVOCATION, profileName: 'mock'})
    expect(profile.driverClass).to.equal('B')
    expect(await store.get('mock')).to.not.equal(undefined)
  })

  it('session/new failure: throws and does NOT persist, but still stops the driver', async () => {
    const svc = makeService({
      acpInitialize: {agentCapabilities: {promptCapabilities: {embeddedContext: true, image: true}}},
      probeSessionResult: false,
    })
    let thrown: unknown
    try {
      await svc.onboard({displayName: 'Flaky', invocation: INVOCATION, profileName: 'flaky'})
    } catch (error) {
      thrown = error
    }

    expect(thrown, 'expected onboard to throw on session/new failure').to.not.equal(undefined)
    expect(await store.get('flaky')).to.equal(undefined)
    expect(lastDriver?.stopped).to.equal(true)
  })

  it('initialize handshake failure: throws, persists nothing, stops the driver', async () => {
    const svc = makeService({startError: new Error('initialize refused')})
    let thrown: unknown
    try {
      await svc.onboard({displayName: 'Bad', invocation: INVOCATION, profileName: 'bad'})
    } catch (error) {
      thrown = error
    }

    expect(thrown).to.not.equal(undefined)
    expect(await store.get('bad')).to.equal(undefined)
    expect(lastDriver?.stopped).to.equal(true)
  })

  it('honors an explicit _meta.brv.driverClass override', async () => {
    const svc = makeService({
      acpInitialize: {
        _meta: {'brv.driverClass': 'C-prime'},
        agentCapabilities: {promptCapabilities: {embeddedContext: true, image: true}},
      },
    })
    const {profile} = await svc.onboard({displayName: 'Mock', invocation: INVOCATION, profileName: 'mock'})
    expect(profile.driverClass).to.equal('C-prime')
  })
})

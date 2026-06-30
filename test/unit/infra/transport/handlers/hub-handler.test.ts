 
import {expect} from 'chai'
import {restore, stub} from 'sinon'

import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'
import type {HubEntryDTO} from '../../../../../src/shared/transport/types/dto.js'

import {HubHandler} from '../../../../../src/server/infra/transport/handlers/hub-handler.js'
import {AnalyticsEventNames} from '../../../../../src/shared/analytics/event-names.js'
import {HubEvents} from '../../../../../src/shared/transport/events/hub-events.js'
import {createMockTransportServer, type MockTransportServer} from '../../../../helpers/mock-factories.js'

function makeFakeAnalyticsClient(): IAnalyticsClient & {trackSpy: ReturnType<typeof stub>} {
  const trackSpy = stub()
  return {
    abort: stub(),
    flush: stub().resolves({events: []}),
    getRuntimeState: stub().resolves({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
    onAuthTransition: stub().resolves(),
    track: trackSpy,
    trackSpy,
  } as unknown as IAnalyticsClient & {trackSpy: ReturnType<typeof stub>}
}

function buildEntry(overrides: Partial<HubEntryDTO> = {}): HubEntryDTO {
  return {
    description: 'test entry',
    files: [],
    id: 'team/pkg',
    name: 'pkg',
    registry: 'official',
    type: 'skill',
    ...overrides,
  } as HubEntryDTO
}

describe('HubHandler analytics emits', () => {
  let transport: MockTransportServer

  beforeEach(() => {
    transport = createMockTransportServer()
  })

  afterEach(() => {
    restore()
  })

  type InstallOutcome = 'success' | 'throw'
  async function createHandler(opts: {
    analyticsClient?: IAnalyticsClient
    entries?: HubEntryDTO[]
    installOutcome?: InstallOutcome
    registryAddOutcome?: 'success' | 'throw_validate' | 'throw_write'
    registryRemoveOutcome?: 'success' | 'throw'
  }): Promise<{handler: HubHandler}> {
    const installFn =
      opts.installOutcome === 'throw'
        ? stub().rejects(new Error('install boom'))
        : stub().resolves({installedFiles: [], installedPath: '/p', message: 'ok'})

    const registries = [
      {authScheme: 'none' as const, name: 'private', url: 'https://example.com'},
    ]
    const removeStub =
      opts.registryRemoveOutcome === 'throw'
        ? stub().rejects(new Error('rm boom'))
        : stub().resolves()

    const hubRegistryConfigStore = {
      addRegistry:
        opts.registryAddOutcome === 'throw_write'
          ? stub().rejects(new Error('write boom'))
          : stub().resolves(),
      getRegistries: stub().resolves(registries),
      removeRegistry: removeStub,
    }
    const hubKeychainStore = {deleteToken: stub().resolves(), getToken: stub().resolves(), setToken: stub().resolves()}
    const hubInstallService = {install: installFn}

    const handler = new HubHandler({
      analyticsClient: opts.analyticsClient,
      hubInstallService: hubInstallService as never,
      hubKeychainStore: hubKeychainStore as never,
      hubRegistryConfigStore: hubRegistryConfigStore as never,
      officialRegistryUrl: 'https://hub.example.com',
      resolveProjectPath: stub().returns('/proj') as never,
      transport,
    })

    // Stub the dynamic registry service before setup() instead of relying on
    // the real composite service network calls.
    const entries = opts.entries ?? [buildEntry()]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(handler as any).hubRegistryService = {
      getEntries: stub().resolves({entries, version: '1'}),
      getEntriesById: stub().resolves(entries),
    }
    // Suppress rebuildRegistryService' real path
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(handler as any).rebuildRegistryService = stub().resolves()
    await handler.setup()
    return {handler}
  }

  async function callInstall(data: Record<string, unknown>): Promise<unknown> {
    const h = transport._handlers.get(HubEvents.INSTALL)
    expect(h, 'hub:install handler should be registered').to.exist
    return h!(data, 'client-1')
  }

  async function callRegistryAdd(data: Record<string, unknown>): Promise<unknown> {
    const h = transport._handlers.get(HubEvents.REGISTRY_ADD)
    expect(h, 'hub:registryAdd handler should be registered').to.exist
    return h!(data, 'client-1')
  }

  async function callRegistryRemove(data: Record<string, unknown>): Promise<unknown> {
    const h = transport._handlers.get(HubEvents.REGISTRY_REMOVE)
    expect(h, 'hub:registryRemove handler should be registered').to.exist
    return h!(data, 'client-1')
  }

  describe('hub_package_installed', () => {
    it('emits outcome=success when install succeeds', async () => {
      const analyticsClient = makeFakeAnalyticsClient()
      await createHandler({analyticsClient})

      await callInstall({entryId: 'team/pkg'})

      const calls = analyticsClient.trackSpy
        .getCalls()
        .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.HUB_PACKAGE_INSTALLED)
      expect(calls.length).to.equal(1)
      const props = calls[0].args[1] as {outcome: string; package_identifier: string}
      expect(props.outcome).to.equal('success')
      expect(props.package_identifier).to.equal('team/pkg')
    })

    it('emits outcome=failure with failure_kind=resolve when entry not found', async () => {
      const analyticsClient = makeFakeAnalyticsClient()
      await createHandler({analyticsClient, entries: []})

      await callInstall({entryId: 'team/missing'})

      const calls = analyticsClient.trackSpy
        .getCalls()
        .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.HUB_PACKAGE_INSTALLED)
      expect(calls.length).to.equal(1)
      const props = calls[0].args[1] as {failure_kind: string; outcome: string}
      expect(props.outcome).to.equal('failure')
      expect(props.failure_kind).to.equal('resolve')
    })

    it('emits outcome=failure with failure_kind=install_failed when install throws', async () => {
      const analyticsClient = makeFakeAnalyticsClient()
      await createHandler({analyticsClient, installOutcome: 'throw'})

      await callInstall({entryId: 'team/pkg'})

      const calls = analyticsClient.trackSpy
        .getCalls()
        .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.HUB_PACKAGE_INSTALLED)
      expect(calls.length).to.equal(1)
      const props = calls[0].args[1] as {failure_kind: string; outcome: string}
      expect(props.outcome).to.equal('failure')
      expect(props.failure_kind).to.equal('install_failed')
    })
  })

  describe('hub_registry_added', () => {
    it('emits outcome=failure with failure_kind=validation on reserved name', async () => {
      const analyticsClient = makeFakeAnalyticsClient()
      await createHandler({analyticsClient})

      const result = await callRegistryAdd({name: 'official', url: 'https://x'})
      expect(result).to.deep.include({success: false})

      const calls = analyticsClient.trackSpy
        .getCalls()
        .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.HUB_REGISTRY_ADDED)
      expect(calls.length).to.equal(1)
      const props = calls[0].args[1] as {failure_kind: string; outcome: string; registry_kind: string}
      expect(props.outcome).to.equal('failure')
      expect(props.failure_kind).to.equal('validation')
      expect(props.registry_kind).to.equal('official')
    })
  })

  describe('hub_registry_removed', () => {
    it('emits outcome=success when remove succeeds', async () => {
      const analyticsClient = makeFakeAnalyticsClient()
      await createHandler({analyticsClient})

      const result = await callRegistryRemove({name: 'private'})
      expect(result).to.deep.include({success: true})

      const calls = analyticsClient.trackSpy
        .getCalls()
        .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.HUB_REGISTRY_REMOVED)
      expect(calls.length).to.equal(1)
      const props = calls[0].args[1] as {outcome: string; registry_kind: string}
      expect(props.outcome).to.equal('success')
      expect(props.registry_kind).to.equal('private')
    })

    it('emits outcome=failure with failure_kind=config_write when remove throws', async () => {
      const analyticsClient = makeFakeAnalyticsClient()
      await createHandler({analyticsClient, registryRemoveOutcome: 'throw'})

      const result = await callRegistryRemove({name: 'private'})
      expect(result).to.deep.include({success: false})

      const calls = analyticsClient.trackSpy
        .getCalls()
        .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.HUB_REGISTRY_REMOVED)
      expect(calls.length).to.equal(1)
      const props = calls[0].args[1] as {failure_kind: string; outcome: string}
      expect(props.outcome).to.equal('failure')
      expect(props.failure_kind).to.equal('config_write')
    })
  })

  it('is a no-op when no analyticsClient is injected (backward-compat)', async () => {
    await createHandler({})

    const result = await callInstall({entryId: 'team/pkg'})
    expect(result).to.deep.include({success: true})
  })
})

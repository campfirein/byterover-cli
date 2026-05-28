import type {AuthScheme} from '../../../../shared/transport/types/auth-scheme.js'
import type {HubEntryDTO} from '../../../../shared/transport/types/dto.js'
import type {HubInstallAuthParams, IHubInstallService} from '../../../core/interfaces/hub/i-hub-install-service.js'
import type {IHubKeychainStore} from '../../../core/interfaces/hub/i-hub-keychain-store.js'
import type {IHubRegistryConfigStore} from '../../../core/interfaces/hub/i-hub-registry-config-store.js'
import type {IHubRegistryService} from '../../../core/interfaces/hub/i-hub-registry-service.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'
import type {ProjectPathResolver} from './handler-types.js'

import {
  HubEvents,
  type HubInstallRequest,
  type HubInstallResponse,
  type HubListResponse,
  type HubRegistryAddRequest,
  type HubRegistryAddResponse,
  type HubRegistryDTO,
  type HubRegistryListResponse,
  type HubRegistryRemoveRequest,
  type HubRegistryRemoveResponse,
} from '../../../../shared/transport/events/hub-events.js'
import {type Agent, isAgent} from '../../../core/domain/entities/agent.js'
import {SKILL_CONNECTOR_CONFIGS} from '../../connectors/skill/skill-connector-config.js'
import {CompositeHubRegistryService} from '../../hub/composite-hub-registry-service.js'
import {HubRegistryService} from '../../hub/hub-registry-service.js'

const OFFICIAL_REGISTRY_NAME = 'official'

const RESERVED_REGISTRY_NAMES = new Set(['brv', 'byterover', 'campfire', 'campfirein', 'official'])

export interface HubHandlerDeps {
  hubInstallService: IHubInstallService
  hubKeychainStore: IHubKeychainStore
  hubRegistryConfigStore: IHubRegistryConfigStore
  officialRegistryUrl: string
  registryTimeoutMs?: number
  resolveProjectPath: ProjectPathResolver
  transport: ITransportServer
}

export class HubHandler {
  private readonly hubInstallService: IHubInstallService
  private readonly hubKeychainStore: IHubKeychainStore
  private readonly hubRegistryConfigStore: IHubRegistryConfigStore
  private hubRegistryService: IHubRegistryService
  private readonly officialRegistryUrl: string
  private readonly registryTimeoutMs?: number
  private readonly resolveProjectPath: ProjectPathResolver
  private readonly transport: ITransportServer

  constructor(deps: HubHandlerDeps) {
    this.hubInstallService = deps.hubInstallService
    this.hubKeychainStore = deps.hubKeychainStore
    this.hubRegistryConfigStore = deps.hubRegistryConfigStore
    this.officialRegistryUrl = deps.officialRegistryUrl
    this.registryTimeoutMs = deps.registryTimeoutMs
    this.resolveProjectPath = deps.resolveProjectPath
    this.transport = deps.transport
    // Will be built during setup
    this.hubRegistryService = new HubRegistryService({
      name: OFFICIAL_REGISTRY_NAME,
      timeoutMs: this.registryTimeoutMs,
      url: deps.officialRegistryUrl,
    })
  }

  async setup(): Promise<void> {
    await this.rebuildRegistryService()

    this.transport.onRequest<void, HubListResponse>(HubEvents.LIST, () => this.handleList())

    this.transport.onRequest<HubInstallRequest, HubInstallResponse>(HubEvents.INSTALL, (data, clientId) =>
      this.handleInstall(data, clientId),
    )

    this.transport.onRequest<HubRegistryAddRequest, HubRegistryAddResponse>(HubEvents.REGISTRY_ADD, (data) =>
      this.handleRegistryAdd(data),
    )

    this.transport.onRequest<HubRegistryRemoveRequest, HubRegistryRemoveResponse>(HubEvents.REGISTRY_REMOVE, (data) =>
      this.handleRegistryRemove(data),
    )

    this.transport.onRequest<void, HubRegistryListResponse>(HubEvents.REGISTRY_LIST, () => this.handleRegistryList())
  }

  /**
   * Default install scope for an agent when the request omits one.
   * Global-only skill agents (no project skill path, e.g. Hermes/OpenClaw)
   * default to 'global' so hub install does not throw "does not support
   * project scope". Explicit `data.scope` always wins over this.
   */
  private defaultScopeForAgent(agent?: Agent): 'global' | 'project' {
    if (!agent) return 'project'
    const skillConfigs: Record<string, {projectPath: null | string}> = SKILL_CONNECTOR_CONFIGS
    const config = skillConfigs[agent]
    return config && !config.projectPath ? 'global' : 'project'
  }

  private async handleInstall(data: HubInstallRequest, clientId: string): Promise<HubInstallResponse> {
    const agent = data.agent && isAgent(data.agent) ? data.agent : undefined
    if (data.agent && !agent) {
      return {installedFiles: [], installedPath: '', message: `Invalid agent: ${data.agent}`, success: false}
    }

    const projectPath = this.resolveEffectivePath(clientId)
    const scope = data.scope ?? this.defaultScopeForAgent(agent)

    const matches = await this.hubRegistryService.getEntriesById(data.entryId).then((entries) => {
      // If a specific registry is requested, filter to that registry
      if (data.registry) {
        return entries.filter((entry) => entry.registry === data.registry)
      }

      return entries
    })

    switch (matches.length) {
      case 0: {
        return {installedFiles: [], installedPath: '', message: `Entry not found: ${data.entryId}`, success: false}
      }

      case 1: {
        // Single match: proceed with install
        return this.performInstall({agent, entry: matches[0], projectPath, scope})
      }

      default: {
        // Multiple matches: detect duplicates
        const registryNames = matches.map((m) => m.registry ?? 'unknown').join(', ')
        return {
          installedFiles: [],
          installedPath: '',
          message: `'${data.entryId}' exists in multiple registries: ${registryNames}. Specify one with --registry <name>.`,
          success: false,
        }
      }
    }
  }

  private async handleList(): Promise<HubListResponse> {
    this.transport.broadcast(HubEvents.LIST_PROGRESS, {message: 'Fetching hub entries...', step: 'fetching'})
    const {entries, version} = await this.hubRegistryService.getEntries()
    return {entries, version}
  }

  private async handleRegistryAdd(data: HubRegistryAddRequest): Promise<HubRegistryAddResponse> {
    try {
      if (RESERVED_REGISTRY_NAMES.has(data.name.toLowerCase())) {
        return {message: `Registry name '${data.name}' is reserved`, success: false}
      }

      // Validate registry is reachable and returns valid data before persisting
      this.transport.broadcast(HubEvents.REGISTRY_ADD_PROGRESS, {message: 'Validating registry...', step: 'validating'})
      const probeService = new HubRegistryService({
        authScheme: data.authScheme,
        authToken: data.token,
        headerName: data.headerName,
        name: data.name,
        timeoutMs: this.registryTimeoutMs,
        url: data.url,
      })
      await probeService.getEntries()

      this.transport.broadcast(HubEvents.REGISTRY_ADD_PROGRESS, {message: 'Saving registry...', step: 'saving'})
      await this.hubRegistryConfigStore.addRegistry({
        ...(data.authScheme ? {authScheme: data.authScheme} : {}),
        ...(data.headerName ? {headerName: data.headerName} : {}),
        name: data.name,
        url: data.url,
      })

      if (data.token) {
        await this.hubKeychainStore.setToken(data.name, data.token)
      }

      await this.rebuildRegistryService()

      return {message: `Registry '${data.name}' added successfully`, success: true}
    } catch (error) {
      return {
        message: `Failed to add registry: ${error instanceof Error ? error.message : 'Unknown error'}`,
        success: false,
      }
    }
  }

  private async handleRegistryList(): Promise<HubRegistryListResponse> {
    this.transport.broadcast(HubEvents.REGISTRY_LIST_PROGRESS, {message: 'Checking registries...', step: 'checking'})
    const registries = await this.hubRegistryConfigStore.getRegistries()

    const allConfigs = [
      {authScheme: 'none' as const, hasToken: false, name: OFFICIAL_REGISTRY_NAME, url: this.officialRegistryUrl},
      ...(await Promise.all(
        registries.map(async (r) => ({
          authScheme: (r.authScheme ?? 'bearer') as AuthScheme,
          hasToken: (await this.hubKeychainStore.getToken(r.name)) !== undefined,
          name: r.name,
          url: r.url,
        })),
      )),
    ]

    const results = await Promise.all(
      allConfigs.map(async (config): Promise<HubRegistryDTO> => {
        try {
          const authToken = await this.hubKeychainStore.getToken(config.name)
          const probe = new HubRegistryService({
            authScheme: config.authScheme,
            authToken,
            name: config.name,
            timeoutMs: this.registryTimeoutMs,
            url: config.url,
          })
          const {entries} = await probe.getEntries()
          return {...config, entryCount: entries.length, status: 'ok'}
        } catch (error) {
          return {
            ...config,
            entryCount: 0,
            error: error instanceof Error ? error.message : 'Unknown error',
            status: 'error',
          }
        }
      }),
    )

    return {registries: results}
  }

  private async handleRegistryRemove(data: HubRegistryRemoveRequest): Promise<HubRegistryRemoveResponse> {
    try {
      await this.hubRegistryConfigStore.removeRegistry(data.name)
      await this.hubKeychainStore.deleteToken(data.name)

      await this.rebuildRegistryService()

      return {message: `Registry '${data.name}' removed successfully`, success: true}
    } catch (error) {
      return {
        message: `Failed to remove registry: ${error instanceof Error ? error.message : 'Unknown error'}`,
        success: false,
      }
    }
  }

  private async performInstall(params: {
    agent?: Agent
    entry: HubEntryDTO
    projectPath: string
    scope?: 'global' | 'project'
  }): Promise<HubInstallResponse> {
    const {agent, entry, projectPath, scope} = params
    try {
      let auth: HubInstallAuthParams | undefined
      if (entry.registry && entry.registry !== OFFICIAL_REGISTRY_NAME) {
        const registries = await this.hubRegistryConfigStore.getRegistries()
        const registryConfig = registries.find((r) => r.name === entry.registry)
        const authToken = (await this.hubKeychainStore.getToken(entry.registry)) ?? undefined
        auth = {
          authScheme: registryConfig?.authScheme,
          authToken,
          headerName: registryConfig?.headerName,
        }
      }

      const result = await this.hubInstallService.install({agent, auth, entry, projectPath, scope})
      const registryLabel = entry.registry ? ` [${entry.registry}]` : ''
      return {
        installedFiles: result.installedFiles,
        installedPath: result.installedPath,
        message: `${result.message}${registryLabel}`,
        success: true,
      }
    } catch (error) {
      return {
        installedFiles: [],
        installedPath: '',
        message: `Install failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        success: false,
      }
    }
  }

  private async rebuildRegistryService(): Promise<void> {
    const officialChild = new HubRegistryService({
      name: OFFICIAL_REGISTRY_NAME,
      timeoutMs: this.registryTimeoutMs,
      url: this.officialRegistryUrl,
    })

    const registries = await this.hubRegistryConfigStore.getRegistries()
    const privateChildren = await Promise.all(
      registries.map(async (r) => {
        const authToken = (await this.hubKeychainStore.getToken(r.name)) ?? undefined
        return new HubRegistryService({
          authScheme: r.authScheme,
          authToken,
          headerName: r.headerName,
          name: r.name,
          timeoutMs: this.registryTimeoutMs,
          url: r.url,
        })
      }),
    )

    this.hubRegistryService = new CompositeHubRegistryService([officialChild, ...privateChildren])
  }

  private resolveEffectivePath(clientId: string): string {
    return this.resolveProjectPath(clientId) ?? process.cwd()
  }
}

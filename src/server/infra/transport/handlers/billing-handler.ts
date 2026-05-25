import type {BillingUsageDTO} from '../../../../shared/transport/types/dto.js'
import type {BillingPinChangedPayload} from '../../../core/domain/transport/schemas.js'
import type {IProviderConfigStore} from '../../../core/interfaces/i-provider-config-store.js'
import type {IBillingService} from '../../../core/interfaces/services/i-billing-service.js'
import type {IAuthStateStore} from '../../../core/interfaces/state/i-auth-state-store.js'
import type {IBillingConfigStore} from '../../../core/interfaces/storage/i-billing-config-store.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'
import type {ProjectPathResolver} from './handler-types.js'

import {
  BillingEvents,
  type BillingGetFreeUserLimitResponse,
  type BillingGetPinnedTeamRequest,
  type BillingGetPinnedTeamResponse,
  type BillingGetUsageRequest,
  type BillingGetUsageResponse,
  type BillingListUsageResponse,
  type BillingResolveResponse,
  type BillingSetPinnedTeamRequest,
  type BillingSetPinnedTeamResponse,
} from '../../../../shared/transport/events/billing-events.js'
import {TransportDaemonEventNames} from '../../../core/domain/transport/schemas.js'
import {getErrorMessage} from '../../../utils/error-helpers.js'
import {resolveBillingForProject} from '../../billing/resolve-billing-source.js'
import {resolveRequiredProjectPath} from './handler-types.js'

export interface BillingHandlerDeps {
  authStateStore: IAuthStateStore
  billingConfigStoreFactory: (projectPath: string) => IBillingConfigStore
  billingService: IBillingService
  providerConfigStore: IProviderConfigStore
  resolveProjectPath: ProjectPathResolver
  transport: ITransportServer
}

const NOT_AUTHENTICATED_ERROR = 'Billing data requires sign-in. Run /login or brv login to sign in.'

export class BillingHandler {
  private readonly authStateStore: IAuthStateStore
  private readonly billingConfigStoreFactory: (projectPath: string) => IBillingConfigStore
  private readonly billingService: IBillingService
  private readonly providerConfigStore: IProviderConfigStore
  private readonly resolveProjectPath: ProjectPathResolver
  private readonly transport: ITransportServer

  constructor(deps: BillingHandlerDeps) {
    this.authStateStore = deps.authStateStore
    this.billingConfigStoreFactory = deps.billingConfigStoreFactory
    this.billingService = deps.billingService
    this.providerConfigStore = deps.providerConfigStore
    this.resolveProjectPath = deps.resolveProjectPath
    this.transport = deps.transport
  }

  setup(): void {
    this.setupGetFreeUserLimit()
    this.setupGetPinnedTeam()
    this.setupGetUsage()
    this.setupListUsage()
    this.setupResolve()
    this.setupSetPinnedTeam()
  }

  private setupGetFreeUserLimit(): void {
    this.transport.onRequest<undefined, BillingGetFreeUserLimitResponse>(
      BillingEvents.GET_FREE_USER_LIMIT,
      async () => {
        const token = this.authStateStore.getToken()
        if (!token?.isValid()) {
          return {error: NOT_AUTHENTICATED_ERROR}
        }

        try {
          const limit = await this.billingService.getFreeUserLimit(token.sessionKey)
          return {limit}
        } catch (error) {
          return {error: getErrorMessage(error)}
        }
      },
    )
  }

  private setupGetPinnedTeam(): void {
    this.transport.onRequest<BillingGetPinnedTeamRequest, BillingGetPinnedTeamResponse>(
      BillingEvents.GET_PINNED_TEAM,
      async (data) => {
        if (!data.projectPath) return {error: 'projectPath is required'}
        try {
          const store = this.billingConfigStoreFactory(data.projectPath)
          const teamId = await store.getPinnedTeamId()
          return teamId === undefined ? {} : {teamId}
        } catch (error) {
          return {error: getErrorMessage(error)}
        }
      },
    )
  }

  private setupGetUsage(): void {
    this.transport.onRequest<BillingGetUsageRequest, BillingGetUsageResponse>(
      BillingEvents.GET_USAGE,
      async (data) => {
        const token = this.authStateStore.getToken()
        if (!token?.isValid()) {
          return {error: NOT_AUTHENTICATED_ERROR}
        }

        try {
          const usages = await this.billingService.getUsages(token.sessionKey)
          const usage = usages.find((u) => u.organizationId === data.organizationId)
          if (!usage) {
            return {error: `No billing usage found for organization ${data.organizationId}`}
          }

          return {usage}
        } catch (error) {
          return {error: getErrorMessage(error)}
        }
      },
    )
  }

  private setupListUsage(): void {
    this.transport.onRequest<undefined, BillingListUsageResponse>(BillingEvents.LIST_USAGE, async () => {
      const token = this.authStateStore.getToken()
      if (!token?.isValid()) {
        return {error: NOT_AUTHENTICATED_ERROR}
      }

      try {
        const usages = await this.billingService.getUsages(token.sessionKey)
        const usage: Record<string, BillingUsageDTO> = {}
        for (const entry of usages) {
          usage[entry.organizationId] = entry
        }

        return {usage}
      } catch (error) {
        return {error: getErrorMessage(error)}
      }
    })
  }

  private setupResolve(): void {
    this.transport.onRequest<undefined, BillingResolveResponse>(BillingEvents.RESOLVE, async (_, clientId) => {
      try {
        const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
        const billing = await resolveBillingForProject({
          authStateStore: this.authStateStore,
          billingConfigStoreFactory: this.billingConfigStoreFactory,
          billingService: this.billingService,
          projectPath,
          providerConfigStore: this.providerConfigStore,
        })
        return {billing}
      } catch (error) {
        return {error: getErrorMessage(error)}
      }
    })
  }

  private setupSetPinnedTeam(): void {
    this.transport.onRequest<BillingSetPinnedTeamRequest, BillingSetPinnedTeamResponse>(
      BillingEvents.SET_PINNED_TEAM,
      async (data) => {
        if (!data.projectPath) return {error: 'projectPath is required', success: false}
        try {
          const {projectPath} = data
          const store = this.billingConfigStoreFactory(projectPath)
          await store.setPinnedTeamId(data.teamId)
          const payload: BillingPinChangedPayload =
            data.teamId === undefined ? {projectPath} : {projectPath, teamId: data.teamId}
          this.transport.broadcast(TransportDaemonEventNames.BILLING_PIN_CHANGED, payload)
          return {success: true}
        } catch (error) {
          return {error: getErrorMessage(error), success: false}
        }
      },
    )
  }
}

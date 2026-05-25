import type {StatusBillingDTO} from '../../../shared/transport/types/dto.js'
import type {IProviderConfigStore} from '../../core/interfaces/i-provider-config-store.js'
import type {IBillingService} from '../../core/interfaces/services/i-billing-service.js'
import type {IAuthStateStore} from '../../core/interfaces/state/i-auth-state-store.js'
import type {IBillingConfigStore} from '../../core/interfaces/storage/i-billing-config-store.js'

import {buildStatusBilling} from './build-status-billing.js'

const BYTEROVER_PROVIDER_ID = 'byterover'

export interface ResolveBillingDeps {
  authStateStore: IAuthStateStore
  billingConfigStoreFactory: (projectPath: string) => IBillingConfigStore
  billingService: IBillingService
  projectPath: string
  providerConfigStore: IProviderConfigStore
}

export async function resolveBillingForProject(deps: ResolveBillingDeps): Promise<StatusBillingDTO | undefined> {
  const activeProvider = await deps.providerConfigStore.getActiveProvider().catch(() => '')

  const token = deps.authStateStore.getToken()
  if (!token?.isValid()) {
    return buildStatusBilling({activeProvider, isAuthenticated: false, paidUsages: []})
  }

  if (activeProvider !== BYTEROVER_PROVIDER_ID) {
    return buildStatusBilling({activeProvider, isAuthenticated: true, paidUsages: []})
  }

  const {sessionKey} = token

  const [pinnedTeamId, usagesResult] = await Promise.all([
    deps
      .billingConfigStoreFactory(deps.projectPath)
      .getPinnedTeamId()
      .catch((): string | undefined => undefined),
    deps.billingService
      .getUsages(sessionKey)
      .then((usages) => ({ok: true as const, usages}))
      .catch(() => ({ok: false as const})),
  ])

  if (!usagesResult.ok) return undefined

  const paidUsages = usagesResult.usages.filter((u) => u.tier !== 'FREE')
  const freeUserLimit =
    paidUsages.length === 0
      ? await deps.billingService.getFreeUserLimit(sessionKey).catch((): undefined => undefined)
      : undefined

  return buildStatusBilling({
    activeProvider,
    freeUserLimit,
    isAuthenticated: true,
    paidUsages,
    pinnedTeamId,
  })
}

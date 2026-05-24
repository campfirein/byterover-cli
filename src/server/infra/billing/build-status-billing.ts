import type {
  BillingFreeUserLimitDTO,
  BillingUsageDTO,
  StatusBillingDTO,
} from '../../../shared/transport/types/dto.js'

import {resolveBillingTeamId} from './resolve-billing-team.js'

const BYTEROVER_PROVIDER_ID = 'byterover'

export interface BuildStatusBillingInput {
  activeProvider: string
  freeUserLimit?: BillingFreeUserLimitDTO
  isAuthenticated: boolean
  paidUsages: readonly BillingUsageDTO[]
  pinnedTeamId?: string
}

export function buildStatusBilling(input: BuildStatusBillingInput): StatusBillingDTO | undefined {
  if (!input.isAuthenticated) return undefined

  if (input.activeProvider !== BYTEROVER_PROVIDER_ID) {
    return {activeProvider: input.activeProvider, source: 'other-provider'}
  }

  const paidIds = input.paidUsages.map((u) => u.organizationId)
  const resolved = resolveBillingTeamId({
    paidOrganizationIds: paidIds,
    pinnedTeamId: input.pinnedTeamId,
  })

  if (resolved === undefined) return freeSource(input.freeUserLimit)

  const usage = input.paidUsages.find((u) => u.organizationId === resolved)
  if (!usage) return {organizationId: resolved, source: 'paid'}

  return {
    organizationId: usage.organizationId,
    organizationName: usage.organizationName,
    remaining: usage.remaining,
    source: 'paid',
    tier: usage.tier,
    total: usage.totalLimit,
  }
}

function freeSource(freeLimit: BillingFreeUserLimitDTO | undefined): StatusBillingDTO {
  if (!freeLimit) return {source: 'free'}
  return {
    remaining: freeLimit.monthly.remaining,
    source: 'free',
    total: freeLimit.monthly.limit,
  }
}

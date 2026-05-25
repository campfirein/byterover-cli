import type {BillingUsageDTO} from '../../../../shared/transport/types/dto'

export function hasPaidTeam(usage?: Record<string, BillingUsageDTO>): boolean {
  if (!usage) return false
  return Object.values(usage).some((u) => u.tier !== 'FREE')
}

export function getPaidOrganizationIds(usage?: Record<string, BillingUsageDTO>): string[] {
  if (!usage) return []
  return Object.values(usage)
    .filter((u) => u.tier !== 'FREE')
    .map((u) => u.organizationId)
}

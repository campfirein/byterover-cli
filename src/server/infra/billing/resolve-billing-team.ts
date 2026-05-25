export interface BillingTeamResolverInput {
  paidOrganizationIds: readonly string[]
  pinnedTeamId?: string
}

export function resolveBillingTeamId(input: BillingTeamResolverInput): string | undefined {
  const {paidOrganizationIds, pinnedTeamId} = input

  if (pinnedTeamId) return pinnedTeamId
  if (paidOrganizationIds.length === 1) return paidOrganizationIds[0]
  return undefined
}

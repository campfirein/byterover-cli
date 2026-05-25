import type {PaidOrganizationsResponse} from '../../core/domain/transport/schemas.js'
import type {IBillingService} from '../../core/interfaces/services/i-billing-service.js'
import type {IAuthStateStore} from '../../core/interfaces/state/i-auth-state-store.js'

import {getErrorMessage} from '../../utils/error-helpers.js'

export interface PaidOrganizationsHandlerDeps {
  authStateStore: IAuthStateStore
  billingService: IBillingService
}

export function createPaidOrganizationsHandler(
  deps: PaidOrganizationsHandlerDeps,
): () => Promise<PaidOrganizationsResponse> {
  return async () => {
    const token = deps.authStateStore.getToken()
    if (!token?.isValid()) return {organizationIds: []}

    try {
      const tiers = await deps.billingService.getTiers(token.sessionKey)
      const organizationIds = tiers
        .filter((tier) => tier.tier !== 'FREE')
        .map((tier) => tier.organizationId)
      return {organizationIds}
    } catch (error) {
      return {error: getErrorMessage(error), organizationIds: []}
    }
  }
}

import type {BillingStateRequest, BillingStateResponse} from '../../core/domain/transport/schemas.js'
import type {IBillingConfigStore} from '../../core/interfaces/storage/i-billing-config-store.js'

export type BillingConfigStoreFactory = (projectPath: string) => IBillingConfigStore

export function createBillingStateHandler(
  storeFactory: BillingConfigStoreFactory,
): (data: BillingStateRequest) => Promise<BillingStateResponse> {
  return async (data) => {
    const store = storeFactory(data.projectPath)
    const pinnedTeamId = await store.getPinnedTeamId()
    return pinnedTeamId === undefined ? {} : {pinnedTeamId}
  }
}

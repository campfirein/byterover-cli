import type {
  BillingFreeUserLimitDTO,
  BillingOrganizationTierDTO,
  BillingUsageDTO,
} from '../../../../shared/transport/types/dto.js'

/**
 * Reads compute-unit usage from the ByteRover billing service.
 * Implementations may be HTTP-based (production) or stubbed (tests).
 */
export interface IBillingService {
  /**
   * Returns the user's free-tier daily/monthly limits.
   *
   * @param sessionKey Authenticated session token (passed via x-byterover-session-id).
   */
  getFreeUserLimit: (sessionKey: string) => Promise<BillingFreeUserLimitDTO>

  /**
   * Returns the tier (FREE/PRO/ENTERPRISE) for every org the user belongs to.
   *
   * @param sessionKey Authenticated session token (passed via x-byterover-session-id).
   */
  getTiers: (sessionKey: string) => Promise<BillingOrganizationTierDTO[]>

  /**
   * Fetches usage for every organization the authenticated user belongs to in
   * a single round trip. Replaces the old per-org `getUsageByProjects` fan-out.
   *
   * @param sessionKey Authenticated session token (passed via x-byterover-session-id).
   */
  getUsages: (sessionKey: string) => Promise<BillingUsageDTO[]>
}

import type {
  BillingFreeUserLimitDTO,
  BillingOrganizationTierDTO,
  BillingUsageDTO,
} from '../../../shared/transport/types/dto.js'
import type {IBillingService} from '../../core/interfaces/services/i-billing-service.js'

import {getErrorMessage} from '../../utils/error-helpers.js'
import {AuthenticatedHttpClient} from '../http/authenticated-http-client.js'

export type BillingServiceConfig = {
  apiBaseUrl: string
  timeout?: number
}

const DEFAULT_TIMEOUT_MS = 10_000

/** Raw `/billing/usages` org entry — `BillingUsageDTO` minus the joined tier fields. */
type RawUsage = Omit<BillingUsageDTO, 'isTrialing' | 'tier'>

interface UsagesResponse {
  organizations: RawUsage[]
}

interface TiersResponse {
  organizations: BillingOrganizationTierDTO[]
}

/**
 * HTTP-backed billing service. `getUsages` joins `/billing/usages` and
 * `/billing/organizations/tiers` in parallel so consumers see tier alongside
 * credit usage in a single DTO. `getFreeUserLimit` mirrors its endpoint 1:1.
 */
export class HttpBillingService implements IBillingService {
  private readonly config: Required<BillingServiceConfig>

  public constructor(config: BillingServiceConfig) {
    this.config = {
      apiBaseUrl: config.apiBaseUrl,
      timeout: config.timeout ?? DEFAULT_TIMEOUT_MS,
    }
  }

  public async getFreeUserLimit(sessionKey: string): Promise<BillingFreeUserLimitDTO> {
    try {
      const httpClient = new AuthenticatedHttpClient(sessionKey)
      const url = `${this.config.apiBaseUrl}/billing/usage/free-user/limit`
      return await httpClient.get<BillingFreeUserLimitDTO>(url, {timeout: this.config.timeout})
    } catch (error) {
      throw new Error(`Failed to fetch free-user limit: ${getErrorMessage(error)}`)
    }
  }

  public async getTiers(sessionKey: string): Promise<BillingOrganizationTierDTO[]> {
    try {
      const httpClient = new AuthenticatedHttpClient(sessionKey)
      const url = `${this.config.apiBaseUrl}/billing/organizations/tiers`
      const response = await httpClient.get<TiersResponse>(url, {timeout: this.config.timeout})
      return response.organizations
    } catch (error) {
      throw new Error(`Failed to fetch billing tiers: ${getErrorMessage(error)}`)
    }
  }

  public async getUsages(sessionKey: string): Promise<BillingUsageDTO[]> {
    const [rawUsages, tiers] = await Promise.all([this.fetchRawUsages(sessionKey), this.getTiers(sessionKey)])
    const tierByOrg = new Map(tiers.map((t) => [t.organizationId, t]))
    return rawUsages.map((usage) => {
      const tier = tierByOrg.get(usage.organizationId)
      return {...usage, isTrialing: tier?.isTrialing ?? false, tier: tier?.tier ?? 'FREE'}
    })
  }

  private async fetchRawUsages(sessionKey: string): Promise<RawUsage[]> {
    try {
      const httpClient = new AuthenticatedHttpClient(sessionKey)
      const url = `${this.config.apiBaseUrl}/billing/usages`
      const response = await httpClient.get<UsagesResponse>(url, {timeout: this.config.timeout})
      return response.organizations
    } catch (error) {
      throw new Error(`Failed to fetch billing usages: ${getErrorMessage(error)}`)
    }
  }
}

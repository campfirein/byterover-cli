import type {ITransportClient} from '@campfirein/brv-transport-client'

import type {StatusBillingDTO} from '../../shared/transport/types/dto.js'

import {BillingEvents, type BillingListUsageResponse} from '../../shared/transport/events/billing-events.js'

export class InsufficientCreditsError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'InsufficientCreditsError'
  }
}

export function isBillingExhausted(billing: StatusBillingDTO): boolean {
  if (billing.source === 'other-provider') return false
  return billing.remaining !== undefined && billing.remaining <= 0
}

export interface EnsureBillingFundsDeps {
  billing: StatusBillingDTO
  client: ITransportClient
}

export async function ensureBillingFunds(deps: EnsureBillingFundsDeps): Promise<void> {
  if (!isBillingExhausted(deps.billing)) return

  if (deps.billing.source === 'free') {
    throw new InsufficientCreditsError(
      'Your free monthly credits are exhausted. Upgrade to a paid team to continue using ByteRover provider.',
    )
  }

  const currentTeamId = 'organizationId' in deps.billing ? deps.billing.organizationId : undefined
  const teams = await fetchOtherPaidTeamNames(deps.client, currentTeamId)
  const suffix = teams.length > 0 ? ` Available teams: ${teams.join(', ')}.` : ''
  throw new InsufficientCreditsError(
    'ByteRover billing team is out of credits. Top up the team, or switch billing target with ' +
      '`brv providers connect byterover --team <name>` before re-running.' +
      suffix,
  )
}

async function fetchOtherPaidTeamNames(client: ITransportClient, excludeTeamId?: string): Promise<string[]> {
  try {
    const response = await client.requestWithAck<BillingListUsageResponse>(BillingEvents.LIST_USAGE)
    return Object.values(response.usage ?? {})
      .filter((usage) => usage.tier !== 'FREE' && usage.organizationId !== excludeTeamId)
      .map((usage) => usage.organizationName)
  } catch {
    return []
  }
}

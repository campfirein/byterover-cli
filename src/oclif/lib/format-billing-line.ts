import type {StatusBillingDTO} from '../../shared/transport/types/dto.js'

export function formatBillingLine(billing: StatusBillingDTO): string {
  if (billing.source === 'other-provider') {
    return `Using ${billing.activeProvider ?? 'another provider'}`
  }

  if (billing.source === 'free') {
    const {remaining, total} = billing
    if (remaining === undefined || total === undefined) return 'Billing: Personal free credits'
    return `Billing: Personal free credits (${formatNumber(remaining)} / ${formatNumber(total)})`
  }

  const label = billing.organizationName ?? billing.organizationId
  if (billing.remaining === undefined || billing.tier === undefined) {
    return `Billing: ${label} (usage unavailable)`
  }

  return `Billing: ${label} (${formatNumber(billing.remaining)} credits, ${billing.tier})`
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}

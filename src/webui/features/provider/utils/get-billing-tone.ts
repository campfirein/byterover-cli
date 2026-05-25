export type BillingTone = 'danger' | 'inactive' | 'ok' | 'warn'

const WARN_PERCENT_THRESHOLD = 90

/**
 * Minimal usage shape required to pick a tone. Both paid orgs (`BillingUsageDTO`)
 * and free-user windows (`BillingFreeUserLimitWindowDTO`) satisfy this — the
 * tone helper doesn't care which billing source it's scoring.
 */
export type BillingToneInput = {
  limitExceeded: boolean
  percentUsed: number
  remaining: number
}

/**
 * Derives the visual tone for the provider trigger / dialog row from a usage
 * payload. Centralized so the header pill and the dialog row agree on what
 * "warn" vs "danger" mean.
 */
export function getBillingTone(usage?: BillingToneInput): BillingTone {
  if (!usage) return 'inactive'

  const {limitExceeded, percentUsed, remaining} = usage
  if (limitExceeded || remaining <= 0) return 'danger'
  if (percentUsed >= WARN_PERCENT_THRESHOLD) return 'warn'
  return 'ok'
}

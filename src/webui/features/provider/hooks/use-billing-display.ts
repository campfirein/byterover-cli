import type {BillingUsageDTO} from '../../../../shared/transport/types/dto'

import {useAuthStore} from '../../auth/stores/auth-store'
import {useGetFreeUserLimit} from '../api/get-free-user-limit'
import {useListBillingUsage} from '../api/list-billing-usage'
import {type BillingTone, type BillingToneInput, getBillingTone} from '../utils/get-billing-tone'
import {getPaidOrganizationIds} from '../utils/has-paid-team'

export interface BillingDisplay {
  billingSource?: BillingToneInput
  billingTone: BillingTone
  hasPaidTeam: boolean
  needsPickPrompt: boolean
  paidOrg?: BillingUsageDTO
  showCreditPill: boolean
  usagesByOrg: Record<string, BillingUsageDTO>
}

export function useBillingDisplay({preferredOrgId}: {preferredOrgId?: string} = {}): BillingDisplay {
  const isAuthorized = useAuthStore((s) => s.isAuthorized)

  const {data: usagesData} = useListBillingUsage({enabled: isAuthorized})
  const usagesByOrg = usagesData?.usage ?? {}
  const paidOrganizationIds = getPaidOrganizationIds(usagesByOrg)
  const hasPaidTeam = paidOrganizationIds.length > 0

  const {data: freeData} = useGetFreeUserLimit({
    enabled: isAuthorized && usagesData !== undefined && !hasPaidTeam,
  })
  const freeMonthly = freeData?.limit?.monthly

  const pinUsage = preferredOrgId ? usagesByOrg[preferredOrgId] : undefined
  const autoPickUsage = paidOrganizationIds.length === 1 ? usagesByOrg[paidOrganizationIds[0]] : undefined
  const resolvedTeam = hasPaidTeam ? (pinUsage ?? autoPickUsage) : undefined
  const isPaidOrg = resolvedTeam !== undefined && resolvedTeam.tier !== 'FREE'
  const billingSource: BillingToneInput | undefined = resolvedTeam ?? freeMonthly
  const billingTone = getBillingTone(billingSource)
  const needsPickPrompt = paidOrganizationIds.length > 1 && resolvedTeam === undefined

  return {
    billingSource,
    billingTone,
    hasPaidTeam,
    needsPickPrompt,
    paidOrg: isPaidOrg ? resolvedTeam : undefined,
    showCreditPill: billingSource !== undefined,
    usagesByOrg,
  }
}

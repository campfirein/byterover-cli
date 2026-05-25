import {queryOptions, useQuery} from '@tanstack/react-query'

import type {QueryConfig} from '../../../lib/react-query'

import {BillingEvents, type BillingListUsageResponse} from '../../../../shared/transport/events'
import {useTransportStore} from '../../../stores/transport-store'

export const listBillingUsage = (): Promise<BillingListUsageResponse> => {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) return Promise.reject(new Error('Not connected'))

  return apiClient.request<BillingListUsageResponse>(BillingEvents.LIST_USAGE)
}

export const listBillingUsageQueryOptions = (enabled: boolean) =>
  queryOptions({
    enabled,
    queryFn: listBillingUsage,
    queryKey: ['billing-list-usage'],
    refetchInterval: 60_000,
  })

type UseListBillingUsageOptions = {
  enabled?: boolean
  queryConfig?: QueryConfig<typeof listBillingUsageQueryOptions>
}

export const useListBillingUsage = ({enabled = true, queryConfig}: UseListBillingUsageOptions = {}) =>
  useQuery({...queryConfig, ...listBillingUsageQueryOptions(enabled)})

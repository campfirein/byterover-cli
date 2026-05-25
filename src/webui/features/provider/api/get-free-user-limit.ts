import {queryOptions, useQuery} from '@tanstack/react-query'

import type {QueryConfig} from '../../../lib/react-query'

import {BillingEvents, type BillingGetFreeUserLimitResponse} from '../../../../shared/transport/events'
import {useTransportStore} from '../../../stores/transport-store'

export const getFreeUserLimit = (): Promise<BillingGetFreeUserLimitResponse> => {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) return Promise.reject(new Error('Not connected'))

  return apiClient.request<BillingGetFreeUserLimitResponse>(BillingEvents.GET_FREE_USER_LIMIT)
}

export const getFreeUserLimitQueryOptions = (enabled: boolean) =>
  queryOptions({
    enabled,
    queryFn: getFreeUserLimit,
    queryKey: ['billing-free-user-limit'],
    refetchInterval: 60_000,
  })

type UseGetFreeUserLimitOptions = {
  enabled?: boolean
  queryConfig?: QueryConfig<typeof getFreeUserLimitQueryOptions>
}

export const useGetFreeUserLimit = ({enabled = true, queryConfig}: UseGetFreeUserLimitOptions = {}) =>
  useQuery({...queryConfig, ...getFreeUserLimitQueryOptions(enabled)})

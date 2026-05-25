import {queryOptions, useQuery} from '@tanstack/react-query'

import type {QueryConfig} from '../../../lib/react-query'

import {ReviewEvents, type ReviewListOperationsResponse} from '../../../../shared/transport/events/review-events'
import {useTransportStore} from '../../../stores/transport-store'

export const getAgentChanges = (): Promise<ReviewListOperationsResponse> => {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) return Promise.reject(new Error('Not connected'))

  return apiClient.request<ReviewListOperationsResponse>(ReviewEvents.LIST_OPERATIONS)
}

export const getAgentChangesQueryOptions = () =>
  queryOptions({
    queryFn: getAgentChanges,
    queryKey: ['review', 'listOperations'],
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
    staleTime: 2000,
  })

type UseGetAgentChangesOptions = {
  queryConfig?: QueryConfig<typeof getAgentChangesQueryOptions>
}

export const useGetAgentChanges = ({queryConfig}: UseGetAgentChangesOptions = {}) =>
  useQuery({
    ...getAgentChangesQueryOptions(),
    ...queryConfig,
  })

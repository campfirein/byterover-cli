import {queryOptions, useQuery} from '@tanstack/react-query'

import type {QueryConfig} from '../../../lib/react-query'

import {ReviewEvents, type ReviewGetDisabledResponse} from '../../../../shared/transport/events/review-events'
import {useTransportStore} from '../../../stores/transport-store'

export const getReviewDisabled = (): Promise<ReviewGetDisabledResponse> => {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) return Promise.reject(new Error('Not connected'))

  return apiClient.request<ReviewGetDisabledResponse>(ReviewEvents.GET_DISABLED)
}

export const getReviewDisabledQueryOptions = () =>
  queryOptions({
    queryFn: getReviewDisabled,
    queryKey: ['review', 'getDisabled'],
    staleTime: 30_000,
  })

type UseGetReviewDisabledOptions = {
  queryConfig?: QueryConfig<typeof getReviewDisabledQueryOptions>
}

export const useGetReviewDisabled = ({queryConfig}: UseGetReviewDisabledOptions = {}) =>
  useQuery({
    ...getReviewDisabledQueryOptions(),
    ...queryConfig,
  })

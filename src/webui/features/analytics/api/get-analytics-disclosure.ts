import {queryOptions, useQuery} from '@tanstack/react-query'

import type {QueryConfig} from '../../../lib/react-query'

import {
  type AnalyticsDisclosureResponse,
  AnalyticsEvents,
} from '../../../../shared/transport/events/analytics-events.js'
import {useTransportStore} from '../../../stores/transport-store'

export const getAnalyticsDisclosure = (): Promise<AnalyticsDisclosureResponse> => {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) return Promise.reject(new Error('Not connected'))
  return apiClient.request<AnalyticsDisclosureResponse, void>(AnalyticsEvents.GET_DISCLOSURE)
}

export const getAnalyticsDisclosureQueryOptions = () =>
  queryOptions({
    queryFn: getAnalyticsDisclosure,
    queryKey: ['analyticsDisclosure'],
  })

type UseGetAnalyticsDisclosureOptions = {
  queryConfig?: QueryConfig<typeof getAnalyticsDisclosureQueryOptions>
}

export const useGetAnalyticsDisclosure = ({queryConfig}: UseGetAnalyticsDisclosureOptions = {}) =>
  useQuery({
    ...getAnalyticsDisclosureQueryOptions(),
    ...queryConfig,
  })

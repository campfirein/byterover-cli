import {useMutation, useQueryClient} from '@tanstack/react-query'

import type {MutationConfig} from '../../../lib/react-query'

import {
  GlobalConfigEvents,
  type GlobalConfigSetAnalyticsRequest,
  type GlobalConfigSetAnalyticsResponse,
} from '../../../../shared/transport/events/global-config-events.js'
import {useTransportStore} from '../../../stores/transport-store'
import {getGlobalConfigQueryOptions} from './get-global-config'

export const setAnalytics = (
  request: GlobalConfigSetAnalyticsRequest,
): Promise<GlobalConfigSetAnalyticsResponse> => {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) return Promise.reject(new Error('Not connected'))
  return apiClient.request<GlobalConfigSetAnalyticsResponse, GlobalConfigSetAnalyticsRequest>(
    GlobalConfigEvents.SET_ANALYTICS,
    request,
  )
}

type UseSetAnalyticsOptions = {
  mutationConfig?: MutationConfig<typeof setAnalytics>
}

export const useSetAnalytics = ({mutationConfig}: UseSetAnalyticsOptions = {}) => {
  const queryClient = useQueryClient()
  const {onSuccess, ...rest} = mutationConfig ?? {}

  return useMutation({
    onSuccess(...args) {
      queryClient.invalidateQueries({queryKey: getGlobalConfigQueryOptions().queryKey})
      onSuccess?.(...args)
    },
    ...rest,
    mutationFn: setAnalytics,
  })
}

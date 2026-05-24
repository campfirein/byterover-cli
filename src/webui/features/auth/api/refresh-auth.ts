import {useMutation, useQueryClient} from '@tanstack/react-query'

import type {MutationConfig} from '../../../lib/react-query'

import {AuthEvents, type AuthRefreshResponse} from '../../../../shared/transport/events'
import {useTransportStore} from '../../../stores/transport-store'
import {AUTH_STATE_QUERY_ROOT} from './get-auth-state'

export const refreshAuth = (): Promise<AuthRefreshResponse> => {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) return Promise.reject(new Error('Not connected'))

  return apiClient.request<AuthRefreshResponse>(AuthEvents.REFRESH)
}

type UseRefreshAuthOptions = {
  mutationConfig?: MutationConfig<typeof refreshAuth>
}

export const useRefreshAuth = ({mutationConfig}: UseRefreshAuthOptions = {}) => {
  const queryClient = useQueryClient()
  const {onSuccess, ...restConfig} = mutationConfig ?? {}

  return useMutation({
    onSuccess(...args) {
      queryClient.invalidateQueries({queryKey: AUTH_STATE_QUERY_ROOT})
      onSuccess?.(...args)
    },
    ...restConfig,
    mutationFn: refreshAuth,
  })
}

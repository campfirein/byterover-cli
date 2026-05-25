import {useMutation, useQueryClient} from '@tanstack/react-query'

import type {MutationConfig} from '../../../lib/react-query'

import {AuthEvents, type AuthLogoutResponse} from '../../../../shared/transport/events'
import {getActiveProviderConfigQueryOptions} from '../../../features/provider/api/get-active-provider-config'
import {getProvidersQueryOptions} from '../../../features/provider/api/get-providers'
import {useTransportStore} from '../../../stores/transport-store'
import {AUTH_STATE_QUERY_ROOT} from './get-auth-state'

export const logout = (): Promise<AuthLogoutResponse> => {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) return Promise.reject(new Error('Not connected'))

  return apiClient.request<AuthLogoutResponse>(AuthEvents.LOGOUT)
}

type UseLogoutOptions = {
  mutationConfig?: MutationConfig<typeof logout>
}

export const useLogout = ({mutationConfig}: UseLogoutOptions = {}) => {
  const queryClient = useQueryClient()
  const {onSuccess, ...restConfig} = mutationConfig ?? {}

  return useMutation({
    onSuccess(...args) {
      queryClient.invalidateQueries({queryKey: AUTH_STATE_QUERY_ROOT})
      queryClient.invalidateQueries({queryKey: getProvidersQueryOptions().queryKey})
      queryClient.invalidateQueries({queryKey: getActiveProviderConfigQueryOptions().queryKey})
      onSuccess?.(...args)
    },
    ...restConfig,
    mutationFn: logout,
  })
}

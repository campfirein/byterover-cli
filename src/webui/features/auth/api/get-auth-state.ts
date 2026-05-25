import {queryOptions, useQuery} from '@tanstack/react-query'

import type {QueryConfig} from '../../../lib/react-query'

import {AuthEvents, type AuthGetStateRequest, type AuthGetStateResponse} from '../../../../shared/transport/events'
import {useTransportStore} from '../../../stores/transport-store'

export const getAuthState = (projectPath: string): Promise<AuthGetStateResponse> => {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) return Promise.reject(new Error('Not connected'))

  return apiClient.request<AuthGetStateResponse, AuthGetStateRequest>(
    AuthEvents.GET_STATE,
    {projectPath},
    {timeout: 5000},
  )
}

export const AUTH_STATE_QUERY_ROOT = ['auth', 'state'] as const

export const getAuthStateQueryOptions = (projectPath: string) =>
  queryOptions({
    enabled: projectPath !== '',
    gcTime: 5 * 60 * 1000,
    queryFn: () => getAuthState(projectPath),
    queryKey: [...AUTH_STATE_QUERY_ROOT, projectPath],
    staleTime: 60 * 1000,
  })

type UseGetAuthStateOptions = {
  queryConfig?: QueryConfig<typeof getAuthStateQueryOptions>
}

export const useGetAuthState = ({queryConfig}: UseGetAuthStateOptions = {}) => {
  const projectPath = useTransportStore((state) => state.selectedProject)
  const baseOptions = getAuthStateQueryOptions(projectPath)
  return useQuery({
    ...baseOptions,
    ...queryConfig,
    enabled: baseOptions.enabled !== false && (queryConfig?.enabled ?? true),
  })
}

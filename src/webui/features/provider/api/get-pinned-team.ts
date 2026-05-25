import {queryOptions, useQuery} from '@tanstack/react-query'

import type {QueryConfig} from '../../../lib/react-query'

import {
  BillingEvents,
  type BillingGetPinnedTeamRequest,
  type BillingGetPinnedTeamResponse,
} from '../../../../shared/transport/events'
import {useTransportStore} from '../../../stores/transport-store'

export const PINNED_TEAM_QUERY_ROOT = ['billing-pinned-team'] as const

export const getPinnedTeam = (projectPath: string): Promise<BillingGetPinnedTeamResponse> => {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) return Promise.reject(new Error('Not connected'))

  return apiClient.request<BillingGetPinnedTeamResponse, BillingGetPinnedTeamRequest>(
    BillingEvents.GET_PINNED_TEAM,
    {projectPath},
  )
}

export const getPinnedTeamQueryOptions = (projectPath: string) =>
  queryOptions({
    enabled: projectPath !== '',
    queryFn: () => getPinnedTeam(projectPath),
    queryKey: [...PINNED_TEAM_QUERY_ROOT, projectPath],
  })

type UseGetPinnedTeamOptions = {
  queryConfig?: QueryConfig<typeof getPinnedTeamQueryOptions>
}

export const useGetPinnedTeam = ({queryConfig}: UseGetPinnedTeamOptions = {}) => {
  const projectPath = useTransportStore((state) => state.selectedProject)
  const baseOptions = getPinnedTeamQueryOptions(projectPath)
  return useQuery({
    ...baseOptions,
    ...queryConfig,
    enabled: baseOptions.enabled !== false && (queryConfig?.enabled ?? true),
  })
}

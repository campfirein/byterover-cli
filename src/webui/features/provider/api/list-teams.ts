import {queryOptions, useQuery} from '@tanstack/react-query'

import type {QueryConfig} from '../../../lib/react-query'

import {TeamEvents, type TeamListResponse} from '../../../../shared/transport/events'
import {useTransportStore} from '../../../stores/transport-store'

export const listTeams = (): Promise<TeamListResponse> => {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) return Promise.reject(new Error('Not connected'))

  return apiClient.request<TeamListResponse>(TeamEvents.LIST)
}

export const listTeamsQueryOptions = (enabled: boolean) =>
  queryOptions({
    enabled,
    queryFn: listTeams,
    queryKey: ['team-list'],
  })

type UseListTeamsOptions = {
  enabled?: boolean
  queryConfig?: QueryConfig<typeof listTeamsQueryOptions>
}

export const useListTeams = ({enabled = true, queryConfig}: UseListTeamsOptions = {}) =>
  useQuery({...queryConfig, ...listTeamsQueryOptions(enabled)})

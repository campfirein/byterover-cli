import {useMutation, useQueryClient} from '@tanstack/react-query'

import {
  BillingEvents,
  type BillingSetPinnedTeamRequest,
  type BillingSetPinnedTeamResponse,
} from '../../../../shared/transport/events'
import {useTransportStore} from '../../../stores/transport-store'
import {PINNED_TEAM_QUERY_ROOT} from './get-pinned-team'

export const setPinnedTeam = (
  projectPath: string,
  teamId: string | undefined,
): Promise<BillingSetPinnedTeamResponse> => {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) return Promise.reject(new Error('Not connected'))

  return apiClient.request<BillingSetPinnedTeamResponse, BillingSetPinnedTeamRequest>(
    BillingEvents.SET_PINNED_TEAM,
    {projectPath, teamId},
  )
}

export const useSetPinnedTeam = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (teamId: string | undefined) =>
      setPinnedTeam(useTransportStore.getState().selectedProject, teamId),
    async onSuccess() {
      await queryClient.invalidateQueries({queryKey: PINNED_TEAM_QUERY_ROOT})
    },
  })
}

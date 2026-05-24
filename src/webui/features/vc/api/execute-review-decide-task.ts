import {useMutation, useQueryClient} from '@tanstack/react-query'

import type {MutationConfig} from '../../../lib/react-query'

import {
  type ReviewDecideTaskRequest,
  type ReviewDecideTaskResponse,
  ReviewEvents,
} from '../../../../shared/transport/events/review-events'
import {useTransportStore} from '../../../stores/transport-store'
import {getAgentChangesQueryOptions} from './get-agent-changes'
import {getVcStatusQueryOptions} from './get-vc-status'

export const executeReviewDecideTask = (request: ReviewDecideTaskRequest): Promise<ReviewDecideTaskResponse> => {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) return Promise.reject(new Error('Not connected'))

  return apiClient.request<ReviewDecideTaskResponse, ReviewDecideTaskRequest>(ReviewEvents.DECIDE_TASK, request)
}

type UseReviewDecideTaskOptions = {
  mutationConfig?: MutationConfig<typeof executeReviewDecideTask>
}

export const useReviewDecideTask = ({mutationConfig}: UseReviewDecideTaskOptions = {}) => {
  const queryClient = useQueryClient()
  const {onSuccess, ...rest} = mutationConfig ?? {}

  return useMutation({
    onSuccess(...args) {
      queryClient.invalidateQueries({queryKey: getAgentChangesQueryOptions().queryKey})
      queryClient.invalidateQueries({queryKey: getVcStatusQueryOptions().queryKey})
      onSuccess?.(...args)
    },
    ...rest,
    mutationFn: executeReviewDecideTask,
  })
}

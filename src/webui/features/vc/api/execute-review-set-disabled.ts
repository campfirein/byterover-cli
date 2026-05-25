import {useMutation, useQueryClient} from '@tanstack/react-query'

import type {MutationConfig} from '../../../lib/react-query'

import {
  ReviewEvents,
  type ReviewSetDisabledRequest,
  type ReviewSetDisabledResponse,
} from '../../../../shared/transport/events/review-events'
import {useTransportStore} from '../../../stores/transport-store'
import {getAgentChangesQueryOptions} from './get-agent-changes'
import {getReviewDisabledQueryOptions} from './get-review-disabled'

export const executeReviewSetDisabled = (request: ReviewSetDisabledRequest): Promise<ReviewSetDisabledResponse> => {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) return Promise.reject(new Error('Not connected'))

  return apiClient.request<ReviewSetDisabledResponse, ReviewSetDisabledRequest>(ReviewEvents.SET_DISABLED, request)
}

type UseReviewSetDisabledOptions = {
  mutationConfig?: MutationConfig<typeof executeReviewSetDisabled>
}

export const useReviewSetDisabled = ({mutationConfig}: UseReviewSetDisabledOptions = {}) => {
  const queryClient = useQueryClient()
  const {onSuccess, ...rest} = mutationConfig ?? {}

  return useMutation({
    onSuccess(...args) {
      queryClient.invalidateQueries({queryKey: getReviewDisabledQueryOptions().queryKey})
      // Toggling HITL flips visibility of agent metadata, so invalidate that cache too.
      queryClient.invalidateQueries({queryKey: getAgentChangesQueryOptions().queryKey})
      onSuccess?.(...args)
    },
    ...rest,
    mutationFn: executeReviewSetDisabled,
  })
}

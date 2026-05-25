import {useMutation} from '@tanstack/react-query'

import type {MutationConfig} from '../../../lib/react-query'

import {
  type TaskCancelRequest,
  type TaskCancelResponse,
  TaskEvents,
} from '../../../../shared/transport/events/task-events'
import {useTransportStore} from '../../../stores/transport-store'

export const cancelTask = async (payload: TaskCancelRequest): Promise<TaskCancelResponse> => {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) throw new Error('Not connected')

  const response = await apiClient.request<TaskCancelResponse, TaskCancelRequest>(TaskEvents.CANCEL, payload)
  if (!response.success) throw new Error(response.error ?? 'Cancel failed')
  return response
}

type UseCancelTaskOptions = {
  mutationConfig?: MutationConfig<typeof cancelTask>
}

export const useCancelTask = ({mutationConfig}: UseCancelTaskOptions = {}) =>
  useMutation({
    ...mutationConfig,
    mutationFn: cancelTask,
  })

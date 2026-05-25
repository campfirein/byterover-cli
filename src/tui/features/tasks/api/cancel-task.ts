/**
 * TUI helper: emit a task:cancel request through the active TUI transport
 * client and surface the daemon's response shape to the caller. Used by the
 * Ctrl+Q keybind in curate/query flow components (T4.2) and any future TUI
 * surface that needs to cancel by id.
 *
 * Components own their cancelling-state UI; this helper only owns the
 * transport emission and the result.
 */

import {
  type TaskCancelRequest,
  type TaskCancelResponse,
  TaskEvents,
} from '../../../../shared/transport/events/index.js'
import {useTransportStore} from '../../../stores/transport-store.js'

export const cancelTask = async (payload: TaskCancelRequest): Promise<TaskCancelResponse> => {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) throw new Error('Not connected')

  const response = await apiClient.request<TaskCancelResponse, TaskCancelRequest>(TaskEvents.CANCEL, payload)
  if (!response.success) throw new Error(response.error ?? 'Cancel failed')
  return response
}

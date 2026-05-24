import {useMutation, useQueryClient} from '@tanstack/react-query'

import type {MutationConfig} from '../../../lib/react-query'

import {
  SettingsEvents,
  type SettingsResetRequest,
  type SettingsResetResponse,
} from '../../../../shared/transport/events/settings-events'
import {useTransportStore} from '../../../stores/transport-store'
import {listSettingsQueryOptions} from './list-settings'

export const resetSetting = (payload: SettingsResetRequest): Promise<SettingsResetResponse> => {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) return Promise.reject(new Error('Not connected'))

  return apiClient.request<SettingsResetResponse, SettingsResetRequest>(SettingsEvents.RESET, payload)
}

type UseResetSettingOptions = {
  mutationConfig?: MutationConfig<typeof resetSetting>
}

export const useResetSetting = ({mutationConfig}: UseResetSettingOptions = {}) => {
  const queryClient = useQueryClient()
  const {onSuccess, ...restConfig} = mutationConfig ?? {}

  return useMutation({
    onSuccess(...args) {
      const [response] = args
      if (response.ok) {
        queryClient.invalidateQueries({queryKey: listSettingsQueryOptions().queryKey})
      }

      onSuccess?.(...args)
    },
    ...restConfig,
    mutationFn: resetSetting,
  })
}

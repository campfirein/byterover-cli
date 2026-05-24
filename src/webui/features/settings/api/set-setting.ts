import {useMutation, useQueryClient} from '@tanstack/react-query'

import type {MutationConfig} from '../../../lib/react-query'

import {
  SettingsEvents,
  type SettingsSetRequest,
  type SettingsSetResponse,
} from '../../../../shared/transport/events/settings-events'
import {useTransportStore} from '../../../stores/transport-store'
import {listSettingsQueryOptions} from './list-settings'

export const setSetting = (payload: SettingsSetRequest): Promise<SettingsSetResponse> => {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) return Promise.reject(new Error('Not connected'))

  return apiClient.request<SettingsSetResponse, SettingsSetRequest>(SettingsEvents.SET, payload)
}

type UseSetSettingOptions = {
  mutationConfig?: MutationConfig<typeof setSetting>
}

export const useSetSetting = ({mutationConfig}: UseSetSettingOptions = {}) => {
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
    mutationFn: setSetting,
  })
}

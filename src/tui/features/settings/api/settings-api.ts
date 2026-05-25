import {queryOptions, useMutation, useQuery, useQueryClient} from '@tanstack/react-query'

import type {QueryConfig} from '../../../lib/react-query.js'

import {
  SettingsEvents,
  type SettingsListResponse,
  type SettingsResetResponse,
  type SettingsSetResponse,
} from '../../../../shared/transport/events/index.js'
import {useTransportStore} from '../../../stores/transport-store.js'

const QUERY_KEY = ['settings'] as const

function requireApiClient() {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) throw new Error('Not connected to daemon')
  return apiClient
}

export function listSettings(): Promise<SettingsListResponse> {
  return requireApiClient().request<SettingsListResponse>(SettingsEvents.LIST)
}

export function setSetting(payload: {key: string; value: unknown}): Promise<SettingsSetResponse> {
  return requireApiClient().request<SettingsSetResponse>(SettingsEvents.SET, payload)
}

export function resetSetting(payload: {key: string}): Promise<SettingsResetResponse> {
  return requireApiClient().request<SettingsResetResponse>(SettingsEvents.RESET, payload)
}

export const settingsQueryOptions = () =>
  queryOptions({
    queryFn: listSettings,
    queryKey: QUERY_KEY,
  })

type UseGetSettingsOptions = {
  queryConfig?: QueryConfig<typeof settingsQueryOptions>
}

export function useGetSettings({queryConfig}: UseGetSettingsOptions = {}) {
  return useQuery({
    ...settingsQueryOptions(),
    ...queryConfig,
  })
}

export function useSetSetting() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: setSetting,
    async onSuccess(response) {
      if (response.ok) await queryClient.invalidateQueries({queryKey: QUERY_KEY})
    },
  })
}

export function useResetSetting() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: resetSetting,
    async onSuccess(response) {
      if (response.ok) await queryClient.invalidateQueries({queryKey: QUERY_KEY})
    },
  })
}

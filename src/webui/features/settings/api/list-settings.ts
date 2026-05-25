import {queryOptions, useQuery} from '@tanstack/react-query'

import type {QueryConfig} from '../../../lib/react-query'

import {SettingsEvents, type SettingsListResponse} from '../../../../shared/transport/events/settings-events'
import {useTransportStore} from '../../../stores/transport-store'

export const listSettings = (): Promise<SettingsListResponse> => {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) return Promise.reject(new Error('Not connected'))

  return apiClient.request<SettingsListResponse>(SettingsEvents.LIST)
}

export const listSettingsQueryOptions = () =>
  queryOptions({
    queryFn: listSettings,
    queryKey: ['settings', 'list'],
  })

type UseGetSettingsOptions = {
  queryConfig?: QueryConfig<typeof listSettingsQueryOptions>
}

export const useGetSettings = ({queryConfig}: UseGetSettingsOptions = {}) =>
  useQuery({
    ...listSettingsQueryOptions(),
    ...queryConfig,
  })

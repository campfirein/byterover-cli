import {useMutation} from '@tanstack/react-query'

import type {MutationConfig} from '../../../lib/react-query'

import {
  MigrateEvents,
  type MigrateRunRequest,
  type MigrateRunResponse,
} from '../../../../shared/transport/events/migrate-events'
import {useTransportStore} from '../../../stores/transport-store'

export const runMigration = (): Promise<MigrateRunResponse> => {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) return Promise.reject(new Error('Not connected'))

  return apiClient.request<MigrateRunResponse, MigrateRunRequest>(MigrateEvents.RUN, {dryRun: false})
}

type UseRunMigrationOptions = {
  mutationConfig?: MutationConfig<typeof runMigration>
}

export const useRunMigration = ({mutationConfig}: UseRunMigrationOptions = {}) =>
  useMutation({
    ...mutationConfig,
    mutationFn: runMigration,
  })

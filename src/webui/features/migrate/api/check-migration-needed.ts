import {queryOptions, useQuery} from '@tanstack/react-query'

import type {QueryConfig} from '../../../lib/react-query'

import {
  MigrateEvents,
  type MigrateRunRequest,
  type MigrateRunResponse,
} from '../../../../shared/transport/events/migrate-events'
import {useTransportStore} from '../../../stores/transport-store'

export type MigrationNeededResult = {
  archiveRoot: string | undefined
  migratedCount: number
  needed: boolean
  projectRoot: string
}

export const checkMigrationNeeded = async (): Promise<MigrationNeededResult> => {
  const {apiClient} = useTransportStore.getState()
  if (!apiClient) throw new Error('Not connected')

  const response = await apiClient.request<MigrateRunResponse, MigrateRunRequest>(MigrateEvents.RUN, {dryRun: true})
  const {report} = response
  return {
    archiveRoot: report.archiveRoot,
    migratedCount: report.summary.migrated,
    needed: report.summary.migrated > 0,
    projectRoot: report.projectRoot,
  }
}

export const checkMigrationNeededQueryOptions = (projectRoot: null | string | undefined) =>
  queryOptions({
    enabled: Boolean(projectRoot),
    queryFn: checkMigrationNeeded,
    queryKey: ['migrate', 'check', projectRoot ?? ''],
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  })

type UseCheckMigrationNeededOptions = {
  projectRoot: null | string | undefined
  queryConfig?: QueryConfig<typeof checkMigrationNeededQueryOptions>
}

export const useCheckMigrationNeeded = ({projectRoot, queryConfig}: UseCheckMigrationNeededOptions) =>
  useQuery({
    ...checkMigrationNeededQueryOptions(projectRoot),
    ...queryConfig,
  })

import {useQueryClient} from '@tanstack/react-query'
import {useEffect} from 'react'

import {ClientEvents} from '../../../../shared/transport/events'
import {useTransportStore} from '../../../stores/transport-store'
import {AUTH_STATE_QUERY_ROOT} from '../../auth/api/get-auth-state'
import {PINNED_TEAM_QUERY_ROOT} from '../../provider/api/get-pinned-team'
import {listBillingUsageQueryOptions} from '../../provider/api/list-billing-usage'

export function ProjectAssociationInitializer() {
  const apiClient = useTransportStore((s) => s.apiClient)
  const isConnected = useTransportStore((s) => s.isConnected)
  const selectedProject = useTransportStore((s) => s.selectedProject)
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!apiClient || !isConnected || !selectedProject) return

    let cancelled = false

    apiClient
      .request(ClientEvents.ASSOCIATE_PROJECT, {projectPath: selectedProject})
      .catch(() => {})
      .finally(() => {
        if (cancelled) return
        queryClient.invalidateQueries({queryKey: AUTH_STATE_QUERY_ROOT}).catch(() => {})
        queryClient.invalidateQueries({queryKey: PINNED_TEAM_QUERY_ROOT}).catch(() => {})
        queryClient.invalidateQueries({queryKey: listBillingUsageQueryOptions(true).queryKey}).catch(() => {})
      })

    return () => {
      cancelled = true
    }
  }, [apiClient, isConnected, queryClient, selectedProject])

  return null
}

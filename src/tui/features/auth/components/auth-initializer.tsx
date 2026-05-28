/**
 * AuthInitializer Component
 *
 * Initializes auth state from transport and subscribes to auth state changes.
 * Must be rendered within TransportProvider.
 */

import {useQueryClient} from '@tanstack/react-query'
import React, {useEffect} from 'react'

import {AuthEvents, type AuthStateChangedEvent} from '../../../../shared/transport/events/index.js'
import {useCommandsStore} from '../../../features/commands/stores/commands-store.js'
import {useTasksStore} from '../../../features/tasks/stores/tasks-store.js'
import {useTransportStore} from '../../../stores/transport-store.js'
import {getAuthStateQueryOptions, useGetAuthState} from '../api/get-auth-state.js'
import {useAuthStore} from '../stores/auth-store.js'

export function AuthInitializer({children}: {children: React.ReactNode}): React.ReactNode {
  const {apiClient} = useTransportStore()
  const queryClient = useQueryClient()
  const setState = useAuthStore((s) => s.setState)

  // Fetch initial auth state (only when transport is connected)
  const {
    data: authState,
    isFetched,
    isLoading,
  } = useGetAuthState({
    queryConfig: {
      enabled: apiClient !== null,
      // One retry covers transient blips; the per-attempt timeout is now generous
      // (3s) so we don't need 5+ retries that would block startup for ~17s when offline.
      retry: 1,
      retryDelay: 500,
      staleTime: 2 * 60 * 1000,
    },
  })

  // Update store when auth state is fetched (including loading state)
  useEffect(() => {
    if (authState) {
      setState({
        brvConfig: authState.brvConfig ?? null,
        isAuthorized: authState.isAuthorized,
        user: authState.user ?? null,
      })
      useAuthStore.setState({isLoadingInitial: false})
    } else if (isFetched && !isLoading) {
      useAuthStore.setState({isLoadingInitial: false})
    }
  }, [authState, isLoading, isFetched, setState])

  // Subscribe to auth state changes
  useEffect(() => {
    if (!apiClient) return

    const unsubscribe = apiClient.on<AuthStateChangedEvent>(AuthEvents.STATE_CHANGED, (data) => {
      setState({
        brvConfig: data.brvConfig,
        isAuthorized: data.isAuthorized,
        user: data.user,
      })

      // Clean up user-specific stores when auth is lost
      if (!data.isAuthorized) {
        useCommandsStore.getState().clearMessages()
        useTasksStore.getState().clearTasks()
      }

      // Re-fetch complete auth state (including brvConfig) when auth is restored.
      // Broadcast omits brvConfig (project-scoped, can't resolve in global broadcast),
      // so we re-fetch GET_STATE which resolves brvConfig via clientId.
      if (data.isAuthorized) {
        queryClient
          .invalidateQueries({
            queryKey: getAuthStateQueryOptions().queryKey,
          })
          .catch(() => {
            // Silently ignore — next poll cycle retries
          })
      }
    })

    return unsubscribe
  }, [apiClient, queryClient, setState])

  // Don't render children until transport is connected
  if (!apiClient) {
    return null
  }

  return <>{children}</>
}

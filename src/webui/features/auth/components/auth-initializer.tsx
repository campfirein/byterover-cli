import type {ReactNode} from 'react'

import {useQueryClient} from '@tanstack/react-query'
import {useEffect} from 'react'

import {AuthEvents, type AuthStateChangedEvent} from '../../../../shared/transport/events'
import {useModelStore} from '../../../features/model/stores/model-store'
import {getActiveProviderConfigQueryOptions} from '../../../features/provider/api/get-active-provider-config'
import {getProvidersQueryOptions} from '../../../features/provider/api/get-providers'
import {useProviderStore} from '../../../features/provider/stores/provider-store'
import {useTransportStore} from '../../../stores/transport-store'
import {AUTH_STATE_QUERY_ROOT, useGetAuthState} from '../api/get-auth-state'
import {useAuthStore} from '../stores/auth-store'

/**
 * Runs auth side effects (initial state fetch + STATE_CHANGED subscription)
 * but never blocks render — only AuthMenu cares about the loading state, and
 * it handles its own skeleton. Mounting this at the route root means the rest
 * of the app can render optimistically while auth resolves.
 */
export function AuthInitializer({children}: {children: ReactNode}) {
  const apiClient = useTransportStore((state) => state.apiClient)
  const connectionState = useTransportStore((state) => state.connectionState)
  const reconnectCount = useTransportStore((state) => state.reconnectCount)
  const queryClient = useQueryClient()
  const setState = useAuthStore((state) => state.setState)

  const {
    data: authState,
    isFetched,
    isLoading,
  } = useGetAuthState({
    queryConfig: {
      enabled: apiClient !== null,
      retry: 5,
      retryDelay: (attemptIndex) => Math.min(500 * 2 ** attemptIndex, 2000),
      staleTime: 2 * 60 * 1000,
    },
  })

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
  }, [authState, isFetched, isLoading, setState])

  useEffect(() => {
    if (!apiClient) return

    const unsubscribe = apiClient.on<AuthStateChangedEvent>(AuthEvents.STATE_CHANGED, (data) => {
      setState({
        brvConfig: data.brvConfig,
        isAuthorized: data.isAuthorized,
        user: data.user,
      })

      if (!data.isAuthorized) {
        useProviderStore.getState().reset()
        useModelStore.getState().reset()
        queryClient.invalidateQueries({queryKey: getProvidersQueryOptions().queryKey})
        queryClient.invalidateQueries({queryKey: getActiveProviderConfigQueryOptions().queryKey})
      }

      if (data.isAuthorized) {
        queryClient.invalidateQueries({queryKey: AUTH_STATE_QUERY_ROOT}).catch(() => {})
      }
    })

    return unsubscribe
  }, [apiClient, queryClient, setState])

  useEffect(() => {
    if (!apiClient) return
    if (connectionState !== 'connected') return
    if (reconnectCount === 0) return

    queryClient.invalidateQueries({queryKey: AUTH_STATE_QUERY_ROOT}).catch(() => {})
  }, [apiClient, connectionState, queryClient, reconnectCount])

  return <>{children}</>
}

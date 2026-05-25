/**
 * App Providers
 *
 * Composes all context providers in the correct order.
 * Single wrapper for repl-startup.tsx to use.
 */

import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import React from 'react'

import {AuthInitializer} from '../features/auth/components/auth-initializer.js'
import {TaskSubscriptionInitializer} from '../features/tasks/components/task-subscription-initializer.js'
import {TransportInitializer} from '../features/transport/components/transport-initializer.js'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // cached data is garbage collected immediately after unmount,
      // so no stale data is ever served
      gcTime: 0,
      refetchOnWindowFocus: false,
      // data is stale immediately,
      // so React Query will refetch on triggers
      staleTime: 0,
    },
  },
})

interface AppProvidersProps {
  children: React.ReactNode
}

export function AppProviders({children}: AppProvidersProps): React.ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <TransportInitializer>
        <AuthInitializer>
          <TaskSubscriptionInitializer />
          {children}
        </AuthInitializer>
      </TransportInitializer>
    </QueryClientProvider>
  )
}

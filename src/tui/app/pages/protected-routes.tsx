/**
 * ProtectedRoutes
 *
 * Renders the home page when auth has resolved.
 */

import React from 'react'

import {useAuthStore} from '../../features/auth/stores/auth-store.js'
import {HomePage} from './home-page.js'

export function ProtectedRoutes(): React.ReactNode {
  const isLoading = useAuthStore((s) => s.isLoadingInitial)
  if (isLoading) return null
  return <HomePage />
}

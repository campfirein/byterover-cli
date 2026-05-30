/**
 * LogoutFlow Component
 *
 * Checks auth state, optionally confirms, then logs out.
 */

import {Text} from 'ink'
import Spinner from 'ink-spinner'
import React, {useEffect, useState} from 'react'

import type {CustomDialogCallbacks} from '../../../types/commands.js'

import {InlineConfirm} from '../../../components/inline-prompts/inline-confirm.js'
import {useGetAuthState} from '../api/get-auth-state.js'
import {useLogout} from '../api/logout.js'

interface LogoutFlowProps extends CustomDialogCallbacks {
  skipConfirm?: boolean
}

type LogoutStep = 'checking' | 'confirm' | 'executing'

export function LogoutFlow({onComplete, skipConfirm}: LogoutFlowProps): React.ReactNode {
  const [step, setStep] = useState<LogoutStep>('checking')
  const [userEmail, setUserEmail] = useState<string>()
  const {data: authData, error: authError, isLoading: isCheckingAuth} = useGetAuthState()
  const logoutMutation = useLogout()

  // Check auth state
  useEffect(() => {
    if (isCheckingAuth || step !== 'checking') return

    if (authError) {
      onComplete(`Logout failed: ${authError.message}`)
      return
    }

    if (authData && (!authData.isAuthorized || !authData.user)) {
      onComplete('You are not currently logged in.')
      return
    }

    if (authData?.user) {
      setUserEmail(authData.user.email)
      if (skipConfirm) {
        setStep('executing')
      } else {
        setStep('confirm')
      }
    }
  }, [authData, authError, isCheckingAuth, onComplete, skipConfirm, step])

  // Execute logout
  useEffect(() => {
    if (step !== 'executing') return

    const execute = async () => {
      try {
        // eslint-disable-next-line unicorn/no-useless-undefined
        const result = await logoutMutation.mutateAsync(undefined)
        if (result.success) {
          onComplete("Successfully logged out.\nRun '/login' to authenticate again.")
        } else {
          onComplete('Logout failed')
        }
      } catch (error) {
        onComplete(`Logout failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    execute()
  }, [step])

  if (step === 'checking' || isCheckingAuth) {
    return (
      <Text>
        <Spinner type="dots" /> Checking authentication...
      </Text>
    )
  }

  if (step === 'confirm') {
    return (
      <InlineConfirm
        default={true}
        message={`Logging out ${userEmail}. Are you sure`}
        onConfirm={(confirmed) => {
          if (confirmed) {
            setStep('executing')
          } else {
            onComplete('Logout cancelled')
          }
        }}
      />
    )
  }

  if (step === 'executing') {
    return (
      <Text>
        <Spinner type="dots" /> Logging out...
      </Text>
    )
  }

  return null
}

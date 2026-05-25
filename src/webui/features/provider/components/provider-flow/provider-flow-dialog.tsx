import {Dialog, DialogContent} from '@campfirein/byterover-packages/components/dialog'
import {useQueryClient} from '@tanstack/react-query'
import {LoaderCircle} from 'lucide-react'
import {useCallback, useEffect, useRef, useState} from 'react'
import {toast} from 'sonner'

import type {ModelDTO, ProviderDTO} from '../../../../../shared/transport/events'

import {formatError} from '../../../../lib/error-messages'
import {useTransportStore} from '../../../../stores/transport-store'
import {useAuthStore} from '../../../auth/stores/auth-store'
import {useSetActiveModel} from '../../../model/api/set-active-model'
import {TourStepBadge} from '../../../onboarding/components/tour-step-badge'
import {useAwaitOAuthCallback} from '../../api/await-oauth-callback'
import {useConnectProvider} from '../../api/connect-provider'
import {useDisconnectProvider} from '../../api/disconnect-provider'
import {getPinnedTeam} from '../../api/get-pinned-team'
import {getProvidersQueryOptions, useGetProviders} from '../../api/get-providers'
import {listBillingUsage} from '../../api/list-billing-usage'
import {listTeams} from '../../api/list-teams'
import {useSetActiveProvider} from '../../api/set-active-provider'
import {useStartOAuth} from '../../api/start-oauth'
import {useValidateApiKey} from '../../api/validate-api-key'
import {hasPaidTeam} from '../../utils/has-paid-team'
import {ApiKeyStep} from './api-key-step'
import {AuthMethodStep} from './auth-method-step'
import {BaseUrlStep} from './base-url-step'
import {LoginPromptStep} from './login-prompt-step'
import {ModelSelectStep} from './model-select-step'
import {type ProviderActionId, ProviderActionStep} from './provider-action-step'
import {ProviderSelectStep} from './provider-select-step'
import {TeamSelectStep} from './team-select-step'

type FlowStep =
  | 'api_key'
  | 'auth_method'
  | 'base_url'
  | 'connecting'
  | 'login_prompt'
  | 'model_select'
  | 'provider_actions'
  | 'select'
  | 'team_select'

const BYTEROVER_PROVIDER_ID = 'byterover'

// Server auth state polls token from disk every ~5s, so right after login the
// connect call may briefly still see "not authenticated". 6 × 1s covers that
// window so the user doesn't have to retry by hand.
const CONNECT_RETRY_MAX_ATTEMPTS = 6
const CONNECT_RETRY_DELAY_MS = 1000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

interface ProviderFlowDialogProps {
  onOpenChange: (open: boolean) => void
  /**
   * Fires when a provider becomes the active one (direct activation, model
   * selected after a fresh connection, or the existing provider re-activated).
   * The dialog still closes itself afterwards via onOpenChange — this is just
   * a discriminator for callers that need to distinguish "success" from
   * "dismissed", e.g. the onboarding tour.
   */
  onProviderActivated?: () => void
  open: boolean
  /** When set, shows a "Step N of M" pill above the dialog content (tour mode). */
  tourStepLabel?: string
}

export function ProviderFlowDialog({onOpenChange, onProviderActivated, open, tourStepLabel}: ProviderFlowDialogProps) {
  const [step, setStep] = useState<FlowStep>('select')
  const [selectedProvider, setSelectedProvider] = useState<ProviderDTO | undefined>()
  const [baseUrl, setBaseUrl] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [isNewConnection, setIsNewConnection] = useState(false)

  // Window reference for the ByteRover OAuth popup. Opened synchronously in the
  // provider row click handler to preserve the user-gesture context (browsers
  // block popups opened later from effects or awaited promises) and handed off
  // to LoginPromptStep, which navigates it to the auth URL.
  const oauthPopupRef = useRef<ReturnType<typeof globalThis.open>>(null)

  const isAuthorized = useAuthStore((s) => s.isAuthorized)
  const projectPath = useTransportStore((s) => s.selectedProject)
  const queryClient = useQueryClient()
  const {data} = useGetProviders()
  const connectMutation = useConnectProvider()
  const disconnectMutation = useDisconnectProvider()
  const setActiveMutation = useSetActiveProvider()
  const validateMutation = useValidateApiKey()
  const startOAuthMutation = useStartOAuth()
  const awaitOAuthMutation = useAwaitOAuthCallback()
  const setActiveModelMutation = useSetActiveModel()

  const providers = data?.providers ?? []

  useEffect(() => {
    if (!open) return
    queryClient.invalidateQueries({queryKey: getProvidersQueryOptions().queryKey})
  }, [open, queryClient])

  const reset = useCallback(() => {
    setStep('select')
    setSelectedProvider(undefined)
    setBaseUrl(undefined)
    setError(undefined)
    setIsNewConnection(false)
  }, [])

  const resetAndClose = useCallback(() => {
    onOpenChange(false)
    // Delay reset until close animation finishes
    setTimeout(reset, 150)
  }, [onOpenChange, reset])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        onOpenChange(true)
      } else {
        onOpenChange(false)
        setTimeout(reset, 150)
      }
    },
    [onOpenChange, reset],
  )

  const connectByteRover = useCallback(
    async (provider: ProviderDTO) => {
      setStep('connecting')
      try {
        let connectResult = await connectMutation.mutateAsync({providerId: provider.id})
        for (let attempt = 0; !connectResult.success && attempt < CONNECT_RETRY_MAX_ATTEMPTS; attempt++) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(CONNECT_RETRY_DELAY_MS)
          // eslint-disable-next-line no-await-in-loop
          connectResult = await connectMutation.mutateAsync({providerId: provider.id})
        }

        if (!connectResult.success) {
          toast.error(connectResult.error ?? 'Failed to connect ByteRover')
          setStep('select')
          return
        }

        await setActiveMutation.mutateAsync({providerId: provider.id})
        toast.success(`Connected to ${provider.name}`)
        onProviderActivated?.()

        const pinned = await getPinnedTeam(projectPath)
        const pinnedTeamId = pinned.teamId

        if (pinnedTeamId) {
          const teamsResponse = await listTeams()
          const teamName = teamsResponse.teams?.find((t) => t.id === pinnedTeamId)?.displayName
          toast.success(`ByteRover usage will be billed to ${teamName ?? 'your previously selected team'}.`)
          resetAndClose()
          return
        }

        const usageData = await listBillingUsage().catch(() => {})

        if (!hasPaidTeam(usageData?.usage)) {
          toast.success('ByteRover usage uses your free monthly credits.')
          resetAndClose()
          return
        }

        setStep('team_select')
      } catch (error_) {
        toast.error(formatError(error_, 'Connection failed'))
        setStep('select')
      }
    },
    [connectMutation, onProviderActivated, resetAndClose, setActiveMutation],
  )

  const handleProviderSelect = useCallback(
    async (provider: ProviderDTO) => {
      setSelectedProvider(provider)
      setError(undefined)

      // ByteRover requires sign-in first. Open the OAuth popup synchronously
      // right here — we're inside the row's click handler, which is still
      // within the user-gesture window browsers require for window.open().
      // Opening later (from useEffect or after await) gets blocked.
      if (provider.id === BYTEROVER_PROVIDER_ID && !isAuthorized) {
        oauthPopupRef.current = window.open('about:blank', '_blank')
        setStep('login_prompt')
        return
      }

      // ByteRover + already current → jump straight to the team picker so
      // re-opening the dialog from the trigger gets the user to billing config.
      if (provider.id === BYTEROVER_PROVIDER_ID && provider.isCurrent) {
        setStep('team_select')
        return
      }

      if (provider.id === BYTEROVER_PROVIDER_ID) {
        setStep('provider_actions')
        return
      }

      if (provider.isConnected) {
        setStep('provider_actions')
        return
      }

      // OpenAI Compatible → base_url step
      if (provider.id === 'openai-compatible') {
        setStep('base_url')
        return
      }

      // Supports OAuth → let user choose between OAuth and API key
      if (provider.supportsOAuth) {
        setStep('auth_method')
        return
      }

      // Requires API key → api_key step
      if (provider.requiresApiKey) {
        setStep('api_key')
        return
      }

      // No key needed → connect directly → model select
      setStep('connecting')
      try {
        await connectMutation.mutateAsync({providerId: provider.id})
        setIsNewConnection(true)
        setStep('model_select')
      } catch (error_) {
        toast.error(formatError(error_, 'Connection failed'))
        setStep('select')
      }
    },
    [connectByteRover, connectMutation, isAuthorized, onProviderActivated, resetAndClose],
  )

  const handleOAuth = useCallback(
    async (provider: ProviderDTO) => {
      setStep('connecting')
      try {
        const result = await startOAuthMutation.mutateAsync({providerId: provider.id})
        if (!result.success) {
          toast.error(result.error ?? 'Failed to start OAuth')
          setStep('select')
          return
        }

        const callbackResult = await awaitOAuthMutation.mutateAsync({providerId: provider.id})
        if (callbackResult.success) {
          setIsNewConnection(true)
          setStep('model_select')
        } else {
          toast.error(callbackResult.error ?? 'OAuth failed')
          setStep('select')
        }
      } catch (error_) {
        toast.error(formatError(error_, 'OAuth failed'))
        setStep('select')
      }
    },
    [awaitOAuthMutation, startOAuthMutation],
  )

  const handleAction = useCallback(
    async (actionId: ProviderActionId) => {
      if (!selectedProvider) return

      switch (actionId) {
        case 'activate': {
          if (selectedProvider.id === BYTEROVER_PROVIDER_ID && !selectedProvider.isConnected) {
            await connectByteRover(selectedProvider)
            break
          }

          setStep('connecting')
          try {
            await setActiveMutation.mutateAsync({providerId: selectedProvider.id})
            toast.success(`Activated ${selectedProvider.name}`)
            onProviderActivated?.()
            if (selectedProvider.id === BYTEROVER_PROVIDER_ID) {
              setStep('team_select')
            } else {
              resetAndClose()
            }
          } catch (error_) {
            setError(formatError(error_, 'Failed'))
            setStep('provider_actions')
          }

          break
        }

        case 'change_model': {
          setStep('model_select')
          break
        }

        case 'disconnect': {
          setStep('connecting')
          try {
            await disconnectMutation.mutateAsync({providerId: selectedProvider.id})
            toast.success(`Disconnected ${selectedProvider.name}`)
            setStep('select')
            setSelectedProvider(undefined)
            setError(undefined)
          } catch (error_) {
            setError(formatError(error_, 'Failed'))
            setStep('provider_actions')
          }

          break
        }

        case 'reconfigure': {
          setStep('base_url')
          break
        }

        case 'reconnect_oauth': {
          await handleOAuth(selectedProvider)
          break
        }

        case 'replace': {
          setStep('api_key')
          break
        }
      }
    },
    [
      connectByteRover,
      disconnectMutation,
      handleOAuth,
      onProviderActivated,
      resetAndClose,
      selectedProvider,
      setActiveMutation,
    ],
  )

  const handleBaseUrlSubmit = useCallback((url: string) => {
    setBaseUrl(url)
    setStep('api_key')
  }, [])

  const handleApiKeySubmit = useCallback(
    async (apiKey: string) => {
      if (!selectedProvider) return

      // Validate first (skip for openai-compatible)
      if (selectedProvider.id !== 'openai-compatible' && apiKey) {
        try {
          const result = await validateMutation.mutateAsync({apiKey, providerId: selectedProvider.id})
          if (!result.isValid) {
            setError(result.error ?? 'Invalid API key')
            return
          }
        } catch (error_) {
          setError(formatError(error_, 'Validation failed'))
          return
        }
      }

      setStep('connecting')
      try {
        await connectMutation.mutateAsync({
          apiKey: apiKey || undefined,
          baseUrl: baseUrl ?? undefined,
          providerId: selectedProvider.id,
        })
        setIsNewConnection(true)
        setStep('model_select')
      } catch (error_) {
        setError(formatError(error_, 'Connection failed'))
        setStep('api_key')
      }
    },
    [baseUrl, connectMutation, selectedProvider, validateMutation],
  )

  const handleModelSelect = useCallback(
    async (model: ModelDTO) => {
      if (!selectedProvider) return

      try {
        await setActiveModelMutation.mutateAsync({
          contextLength: model.contextLength,
          modelId: model.id,
          providerId: selectedProvider.id,
        })

        if (isNewConnection) {
          toast.success(`Connected to ${selectedProvider.name}`)
          onProviderActivated?.()
          resetAndClose()
        } else {
          toast.success(`Model set to ${model.name}`)
          setStep('provider_actions')
        }
      } catch (error_) {
        toast.error(formatError(error_, 'Failed to set model'))
      }
    },
    [isNewConnection, onProviderActivated, resetAndClose, selectedProvider, setActiveModelMutation],
  )

  const handleApiKeyBack = useCallback(() => {
    setError(undefined)
    if (selectedProvider?.id === 'openai-compatible') {
      setStep('base_url')
    } else if (selectedProvider?.supportsOAuth) {
      setStep('auth_method')
    } else {
      setStep('select')
    }
  }, [selectedProvider])

  const renderStep = () => {
    switch (step) {
      case 'api_key': {
        return selectedProvider ? (
          <ApiKeyStep
            error={error}
            isOptional={selectedProvider.id === 'openai-compatible'}
            isValidating={validateMutation.isPending}
            onBack={handleApiKeyBack}
            onSubmit={(key) => handleApiKeySubmit(key)}
            provider={selectedProvider}
          />
        ) : null
      }

      case 'auth_method': {
        return selectedProvider ? (
          <AuthMethodStep
            onBack={() => {
              setStep('select')
              setSelectedProvider(undefined)
              setError(undefined)
            }}
            onSelect={(method) => {
              if (method === 'oauth') {
                handleOAuth(selectedProvider)
              } else {
                setStep('api_key')
              }
            }}
            provider={selectedProvider}
          />
        ) : null
      }

      case 'base_url': {
        return selectedProvider ? (
          <BaseUrlStep
            error={error}
            onBack={() => {
              setStep('select')
              setError(undefined)
            }}
            onSubmit={handleBaseUrlSubmit}
            provider={selectedProvider}
          />
        ) : null
      }

      case 'connecting': {
        return (
          <div className="flex flex-col items-center gap-3 py-12">
            <LoaderCircle className="text-primary size-6 animate-spin" />
            <p className="text-muted-foreground text-sm">Connecting to {selectedProvider?.name}...</p>
          </div>
        )
      }

      case 'login_prompt': {
        return selectedProvider ? (
          <LoginPromptStep
            onAuthenticated={() => {
              connectByteRover(selectedProvider)
            }}
            onBack={() => {
              setStep('select')
              setSelectedProvider(undefined)
            }}
            popup={oauthPopupRef.current}
          />
        ) : null
      }

      case 'model_select': {
        return selectedProvider ? (
          <ModelSelectStep
            onBack={() => {
              if (isNewConnection) {
                setStep('select')
              } else {
                setStep('provider_actions')
              }
            }}
            onSelect={handleModelSelect}
            providerId={selectedProvider.id}
          />
        ) : null
      }

      case 'provider_actions': {
        return selectedProvider ? (
          <ProviderActionStep
            error={error}
            onAction={handleAction}
            onBack={() => {
              setStep('select')
              setSelectedProvider(undefined)
              setError(undefined)
            }}
            provider={selectedProvider}
          />
        ) : null
      }

      case 'select': {
        return <ProviderSelectStep onSelect={(p) => handleProviderSelect(p)} providers={providers} />
      }

      case 'team_select': {
        return (
          <TeamSelectStep
            onBack={() => {
              setStep('select')
              setSelectedProvider(undefined)
              setError(undefined)
            }}
            onComplete={() => {
              onProviderActivated?.()
              resetAndClose()
            }}
          />
        )
      }

      default: {
        return null
      }
    }
  }

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent
        className="flex h-150 flex-col sm:max-w-lg"
        showCloseButton={
          step === 'select' ||
          step === 'model_select' ||
          step === 'connecting' ||
          step === 'login_prompt' ||
          step === 'team_select'
        }
      >
        {tourStepLabel && <TourStepBadge label={tourStepLabel} />}
        {renderStep()}
      </DialogContent>
    </Dialog>
  )
}

import {Button} from '@campfirein/byterover-packages/components/button'
import {DialogFooter, DialogHeader, DialogTitle} from '@campfirein/byterover-packages/components/dialog'
import {useQueryClient} from '@tanstack/react-query'
import {ChevronLeft, ExternalLink, LoaderCircle} from 'lucide-react'
import {useEffect, useRef, useState} from 'react'

import {useTransportStore} from '../../../../stores/transport-store'
import {AUTH_STATE_QUERY_ROOT, getAuthStateQueryOptions} from '../../../auth/api/get-auth-state'
import {login, subscribeToLoginCompleted} from '../../../auth/api/login'
import {useAuthStore} from '../../../auth/stores/auth-store'
import {isSafeHttpUrl} from '../../../auth/utils/is-safe-http-url'

/**
 * The Window reference returned by window.open, expressed without naming the
 * DOM type directly (ESLint's no-undef doesn't ship with browser globals).
 */
type PopupRef = ReturnType<typeof globalThis.open>

interface LoginPromptStepProps {
  onAuthenticated: () => void
  onBack: () => void
  /**
   * The OAuth popup. ProviderSelectStep opens it synchronously from the row
   * click (user-gesture context), then hands it here for the step to navigate
   * once the auth URL is ready.
   */
  popup: PopupRef
}

type InnerState =
  | {authUrl: string; type: 'blocked'}
  | {authUrl: string; type: 'waiting'}
  | {message: string; type: 'error'}
  | {type: 'starting'}

const POLL_INTERVAL_MS = 2500
/**
 * Minimum time the "Signing in to ByteRover" dialog stays visible before we
 * navigate the popup. Keeps the transition legible — without it the popup
 * races to the auth URL before the user sees the step.
 */
const MIN_VISIBLE_DELAY_MS = 800

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function LoginPromptStep({onAuthenticated, onBack, popup}: LoginPromptStepProps) {
  const queryClient = useQueryClient()
  const isAuthorized = useAuthStore((s) => s.isAuthorized)
  const setLoggingIn = useAuthStore((s) => s.setLoggingIn)
  const selectedProject = useTransportStore((s) => s.selectedProject)
  const [state, setState] = useState<InnerState>({type: 'starting'})
  const [retryCount, setRetryCount] = useState(0)
  const didStartRef = useRef(false)

  // Kick off the OAuth request as soon as the step mounts. The popup was
  // already opened synchronously in the row click handler upstream.
  useEffect(() => {
    if (didStartRef.current) return
    didStartRef.current = true
    setLoggingIn(true)
    let cancelled = false

    async function start() {
      try {
        const [response] = await Promise.all([login(), sleep(MIN_VISIBLE_DELAY_MS)])
        if (cancelled) return
        if (!isSafeHttpUrl(response.authUrl)) {
          popup?.close()
          setState({message: 'Received an unsafe OAuth URL from the daemon', type: 'error'})
          setLoggingIn(false)
          return
        }

        if (popup && !popup.closed) {
          popup.location.href = response.authUrl
          setState({authUrl: response.authUrl, type: 'waiting'})
        } else {
          // Popup was blocked or closed before navigation. Fall back to an
          // explicit user-initiated open via the action button below.
          setState({authUrl: response.authUrl, type: 'blocked'})
        }
      } catch (error) {
        if (cancelled) return
        setLoggingIn(false)
        setState({
          message: error instanceof Error ? error.message : 'Unable to start login',
          type: 'error',
        })
      }
    }

    start().catch(() => {
      // error already surfaced via state
    })

    return () => {
      cancelled = true
    }
    // `retryCount` is a trigger, not read inside the effect — it forces a
    // re-run when the user hits "Retry sign-in" after a failure.
  }, [popup, setLoggingIn, retryCount])

  // Auto-continue once auth flips to authorized (from LOGIN_COMPLETED or poll).
  useEffect(() => {
    if (isAuthorized && state.type === 'waiting') {
      setLoggingIn(false)
      onAuthenticated()
    }
  }, [isAuthorized, onAuthenticated, setLoggingIn, state.type])

  useEffect(() => {
    if (state.type !== 'waiting') return

    const unsubscribe = subscribeToLoginCompleted((data) => {
      if (data.success && data.user) {
        queryClient.invalidateQueries({queryKey: AUTH_STATE_QUERY_ROOT})
      } else {
        setState({message: data.error ?? 'Authentication failed', type: 'error'})
      }

      setLoggingIn(false)
    })

    return unsubscribe
  }, [queryClient, setLoggingIn, state.type])

  useEffect(() => {
    if (state.type !== 'waiting') return

    let cancelled = false

    async function poll() {
      try {
        const result = await queryClient.fetchQuery(getAuthStateQueryOptions(selectedProject))
        if (cancelled) return
        if (result.isAuthorized) {
          queryClient.invalidateQueries({queryKey: AUTH_STATE_QUERY_ROOT})
          setLoggingIn(false)
        }
      } catch {
        // next tick retries
      }
    }

    const intervalId = globalThis.setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      globalThis.clearInterval(intervalId)
    }
  }, [queryClient, selectedProject, setLoggingIn, state.type])

  function retry() {
    // Clear the guard and bump `retryCount` so the start effect re-runs —
    // state alone isn't in its deps list, so setState isn't enough.
    didStartRef.current = false
    setState({type: 'starting'})
    setRetryCount((n) => n + 1)
  }

  return (
    <div className="flex flex-1 flex-col gap-6">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <button className="hover:bg-muted rounded p-0.5 transition-colors" onClick={onBack} type="button">
            <ChevronLeft className="size-5" />
          </button>
          Signing in to ByteRover
        </DialogTitle>
      </DialogHeader>

      <div className="flex flex-col gap-4">
        {state.type === 'starting' && (
          <div className="border-primary/30 bg-primary/5 flex items-center gap-2 rounded-lg border p-3 text-sm">
            <LoaderCircle className="text-primary-foreground size-4 animate-spin" />
            Preparing sign-in…
          </div>
        )}

        {state.type === 'waiting' && (
          <div className="border-primary/30 bg-primary/5 flex flex-col gap-1 rounded-lg border p-3">
            <div className="flex items-center gap-2 text-sm">
              <LoaderCircle className="text-primary-foreground size-4 animate-spin" />
              Finish signing in in the new tab.
            </div>
            <div className="text-muted-foreground pl-6 text-xs">
              If the tab didn&rsquo;t open,{' '}
              <a className="underline underline-offset-2" href={state.authUrl} rel="noopener noreferrer" target="_blank">
                click this link
              </a>
              .
            </div>
          </div>
        )}

        {state.type === 'blocked' && (
          <div className="border-border bg-muted text-foreground flex items-center gap-2 rounded-lg border p-3 text-sm">
            <ExternalLink className="size-4 shrink-0" />
            Your browser blocked the sign-in popup.
          </div>
        )}

        {state.type === 'error' && (
          <div className="text-destructive bg-destructive/10 rounded-lg px-4 py-2.5 text-sm">{state.message}</div>
        )}
      </div>

      <DialogFooter className="mt-auto">
        <Button onClick={onBack} variant="secondary">
          Use a different provider
        </Button>
        {state.type === 'error' && <Button onClick={retry}>Retry sign-in</Button>}
        {state.type === 'blocked' && (
          <Button
            onClick={() => {
              window.open(state.authUrl, '_blank', 'noopener,noreferrer')
              setState({authUrl: state.authUrl, type: 'waiting'})
            }}
          >
            <ExternalLink className="size-3.5" />
            Open sign-in page
          </Button>
        )}
        {(state.type === 'starting' || state.type === 'waiting') && (
          <Button disabled>Waiting…</Button>
        )}
      </DialogFooter>
    </div>
  )
}

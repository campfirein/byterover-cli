import {Button} from '@campfirein/byterover-packages/components/button'
import {Card} from '@campfirein/byterover-packages/components/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@campfirein/byterover-packages/components/dialog'
import {useQueryClient} from '@tanstack/react-query'
import {useEffect, useState} from 'react'
import {toast} from 'sonner'

import {useTransportStore} from '../../../stores/transport-store'
import {AUTH_STATE_QUERY_ROOT, getAuthStateQueryOptions} from '../api/get-auth-state'
import {login, subscribeToLoginCompleted} from '../api/login'
import {useAuthStore} from '../stores/auth-store'
import {isSafeHttpUrl} from '../utils/is-safe-http-url'

type LoginDialogProps = {
  onOpenChange: (open: boolean) => void
  open: boolean
}

type DialogState =
  | {authUrl: string; type: 'waiting'}
  | {message: string; type: 'error'}
  | {type: 'idle'}
  | {type: 'starting'}

const POLL_INTERVAL_MS = 2500

export function LoginDialog({onOpenChange, open}: LoginDialogProps) {
  const queryClient = useQueryClient()
  const isLoggingIn = useAuthStore((s) => s.isLoggingIn)
  const setLoggingIn = useAuthStore((s) => s.setLoggingIn)
  const connectionState = useTransportStore((s) => s.connectionState)
  const selectedProject = useTransportStore((s) => s.selectedProject)
  const [state, setState] = useState<DialogState>({type: 'idle'})

  useEffect(() => {
    if (!open) {
      setState({type: 'idle'})
      setLoggingIn(false)
    }
  }, [open, setLoggingIn])

  useEffect(() => {
    if (state.type !== 'waiting') return

    const unsubscribe = subscribeToLoginCompleted((data) => {
      if (data.success && data.user) {
        toast.success(`Logged in as ${data.user.email}`)
        queryClient.invalidateQueries({queryKey: AUTH_STATE_QUERY_ROOT})
        onOpenChange(false)
      } else {
        setState({message: data.error ?? 'Authentication failed', type: 'error'})
      }

      setLoggingIn(false)
    })

    return unsubscribe
  }, [onOpenChange, queryClient, selectedProject, setLoggingIn, state.type])

  // Fallback path: poll the daemon while waiting in case the LOGIN_COMPLETED
  // broadcast was missed (tab backgrounded, transient socket drop, etc).
  useEffect(() => {
    if (state.type !== 'waiting') return

    let cancelled = false

    async function poll() {
      try {
        const result = await queryClient.fetchQuery(getAuthStateQueryOptions(selectedProject))
        if (cancelled) return
        if (result.isAuthorized && result.user) {
          toast.success(`Logged in as ${result.user.email}`)
          setLoggingIn(false)
          onOpenChange(false)
        }
      } catch {
        // Ignore poll errors; the next tick will retry.
      }
    }

    const intervalId = globalThis.setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      globalThis.clearInterval(intervalId)
    }
  }, [onOpenChange, queryClient, setLoggingIn, state.type])

  async function handleProceed() {
    setLoggingIn(true)
    setState({type: 'starting'})

    try {
      const response = await login()
      if (!isSafeHttpUrl(response.authUrl)) {
        throw new Error('Received an unsafe OAuth URL from the daemon')
      }

      // Best-effort: try to open the auth URL in a new tab. If the browser
      // blocks the popup (gesture chain broken by the await above), the inline
      // link in the waiting state lets the user open it manually.
      window.open(response.authUrl, '_blank', 'noopener,noreferrer')
      setState({authUrl: response.authUrl, type: 'waiting'})
    } catch (error) {
      setLoggingIn(false)
      setState({
        message: error instanceof Error ? error.message : 'Unable to start login',
        type: 'error',
      })
    }
  }

  function handleRetry() {
    setState({type: 'idle'})
  }

  const isProceedDisabled = connectionState !== 'connected' || isLoggingIn

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Redirecting to ByteRover</DialogTitle>
          <DialogDescription>
            Please sign in to your <span className="text-foreground">byterover.dev</span> account to continue.
          </DialogDescription>
        </DialogHeader>

        {state.type === 'starting' && (
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 text-sm text-blue-700">
            Starting authentication…
          </div>
        )}

        {state.type === 'waiting' && (
          <Card className="p-4 gap-2">
            <div>Finish signing in in the new tab.</div>
            <div className="text-xs text-muted-foreground">
              If the tab didn’t open,{' '}
              <a
                className="underline underline-offset-2"
                href={state.authUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                click this link
              </a>
              .
            </div>
          </Card>
        )}

        {state.type === 'error' && (
          <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
            {state.message}
          </div>
        )}

        <DialogFooter>
          {state.type === 'error' ? (
            <>
              <DialogClose render={<Button className="cursor-pointer" variant="ghost" />}>Cancel</DialogClose>
              <Button className="cursor-pointer" onClick={handleRetry}>
                Try again
              </Button>
            </>
          ) : (
            <>
              <DialogClose render={<Button className="cursor-pointer" variant="ghost" />}>Cancel</DialogClose>
              <Button className="cursor-pointer" disabled={isProceedDisabled} onClick={handleProceed}>
                {state.type === 'waiting' ? 'Waiting for authentication…' : 'Proceed to Login'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

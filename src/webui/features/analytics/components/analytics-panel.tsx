import {Collapsible, CollapsibleContent, CollapsibleTrigger} from '@campfirein/byterover-packages/components/collapsible'
import {Skeleton} from '@campfirein/byterover-packages/components/skeleton'
import {Switch} from '@campfirein/byterover-packages/components/switch'
import {ChevronDown, ExternalLink, ShieldCheck} from 'lucide-react'
import {useState} from 'react'
import {toast} from 'sonner'

import {formatError} from '../../../lib/error-messages'
import {noop} from '../../../lib/noop'
import {useGetGlobalConfig} from '../api/get-global-config'
import {useSetAnalytics} from '../api/set-analytics'
import {ANALYTICS_PRIVACY_URL} from '../constants'
import {DisableConfirmDialog} from './disable-confirm-dialog'
import {DisclosureDetails} from './disclosure-details'
import {EnableConfirmDialog} from './enable-confirm-dialog'

export function AnalyticsPanel() {
  const {data, error, isError, isLoading, refetch} = useGetGlobalConfig()
  const setAnalytics = useSetAnalytics()
  const [pendingIntent, setPendingIntent] = useState<'disable' | 'enable' | undefined>()
  const [detailsOpen, setDetailsOpen] = useState(false)

  const analytics = data?.analytics ?? false

  function requestToggle(next: boolean) {
    if (setAnalytics.isPending) return
    if (analytics === next) return
    setPendingIntent(next ? 'enable' : 'disable')
  }

  async function applyChange(next: boolean) {
    try {
      await setAnalytics.mutateAsync({analytics: next})
      toast.success(next ? 'Analytics enabled.' : 'Analytics disabled.')
    } catch (error_) {
      toast.error(formatError(error_, 'Failed to update analytics setting.'))
    } finally {
      setPendingIntent(undefined)
    }
  }

  function handleDialogOpenChange(open: boolean) {
    if (!open && !setAnalytics.isPending) setPendingIntent(undefined)
  }

  return (
    <div className="flex w-full flex-col gap-3.5">
      <div className="flex flex-col">
        <h2 className="text-foreground text-[0.95rem] font-semibold leading-tight">Analytics</h2>
        <p className="text-muted-foreground mt-0.5 text-[0.8125rem] leading-snug">
          Control how usage data is collected to improve Byterover.
        </p>
      </div>

      {isError ? (
        <p className="text-destructive text-sm">
          ✗ {formatError(error, 'Failed to load analytics state')}
          {' · '}
          <button
            className="underline underline-offset-2"
            onClick={() => refetch().catch(noop)}
            type="button"
          >
            retry
          </button>
        </p>
      ) : (
        <div className="bg-card flex flex-col rounded-xl border">
          <div className="flex items-start justify-between gap-4 px-5 py-4">
            <div className="flex min-w-0 flex-col">
              <span className="text-foreground text-sm font-medium" id="analytics-switch-label">
                Share usage analytics
              </span>
              <span className="text-muted-foreground mt-0.5 text-[0.8125rem] leading-snug">
                Help us build a better Byterover by sharing your usage insights securely.
              </span>
            </div>
            {isLoading ? (
              <Skeleton className="h-[18.4px] w-8 rounded-full" />
            ) : (
              <Switch
                aria-labelledby="analytics-switch-label"
                checked={analytics}
                disabled={setAnalytics.isPending}
                onCheckedChange={requestToggle}
              />
            )}
          </div>

          <Collapsible onOpenChange={setDetailsOpen} open={detailsOpen}>
            <CollapsibleTrigger className="text-foreground hover:bg-muted/40 group flex w-full cursor-pointer items-center gap-2.5 border-t px-5 py-3 text-left text-sm transition-colors">
              <ShieldCheck className="text-muted-foreground size-4" strokeWidth={1.75} />
              <span className="flex-1">What data will be collected?</span>
              <span className="text-muted-foreground flex items-center gap-1 text-xs">
                {detailsOpen ? 'Hide details' : 'Show details'}
                <ChevronDown className="size-3.5 transition-transform group-data-[panel-open]:rotate-180" />
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="border-t px-5 py-5">
              <DisclosureDetails />
            </CollapsibleContent>
          </Collapsible>

          <a
            className="text-foreground/80 hover:text-foreground inline-flex items-center gap-2 border-t px-5 py-3 text-sm transition-colors"
            href={ANALYTICS_PRIVACY_URL}
            rel="noopener noreferrer"
            target="_blank"
          >
            <ExternalLink className="size-3.5 text-primary" />
            <span className="text-primary">docs.byterover.dev/privacy</span>
          </a>
        </div>
      )}

      <EnableConfirmDialog
        isPending={setAnalytics.isPending}
        onConfirm={() => applyChange(true)}
        onOpenChange={handleDialogOpenChange}
        open={pendingIntent === 'enable'}
      />
      <DisableConfirmDialog
        isPending={setAnalytics.isPending}
        onConfirm={() => applyChange(false)}
        onOpenChange={handleDialogOpenChange}
        open={pendingIntent === 'disable'}
      />
    </div>
  )
}

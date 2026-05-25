import {CopyButton} from '@campfirein/byterover-packages/components/copy-button'
import {Tooltip, TooltipContent, TooltipTrigger} from '@campfirein/byterover-packages/components/tooltip'
import {RefreshCw, X} from 'lucide-react'

import {useRestartBannerStore} from '../stores/restart-banner-store'

const SNIPPET = 'brv restart'

export function RestartBanner() {
  const dirty = useRestartBannerStore((s) => s.dirtyKeys.size > 0)
  const clear = useRestartBannerStore((s) => s.clear)

  if (!dirty) return null

  return (
    <div className="border-border bg-muted/40 flex items-center justify-between gap-3 rounded-md border border-dashed px-3.5 py-2.5">
      <div className="text-foreground flex min-w-0 items-center gap-2.5">
        <RefreshCw className="size-3.5 shrink-0 animate-pulse text-amber-400" />
        <span className="text-sm">Settings changed — restart to apply</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <div className="bg-background flex items-center gap-2 rounded border px-2.5 py-1 font-mono text-xs">
          <span>
            <span className="text-muted-foreground">$</span> {SNIPPET}
          </span>
          <CopyButton className="-mr-1" showCopiedText={false} textToCopy={SNIPPET} />
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                aria-label="Dismiss"
                className="text-muted-foreground hover:text-foreground hover:bg-muted flex size-7 cursor-pointer items-center justify-center rounded transition-colors"
                onClick={clear}
                type="button"
              />
            }
          >
            <X className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>Dismiss</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

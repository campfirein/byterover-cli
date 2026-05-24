import type {ReactNode} from 'react'

import {Button} from '@campfirein/byterover-packages/components/button'
import {AlertCircle, RotateCw} from 'lucide-react'

import {formatError} from '../../../lib/error-messages'

type Props = {
  action?: ReactNode
  children?: ReactNode
  compact?: boolean
  description: string
  error?: unknown
  errorFallback?: string
  onRetry?: () => void
  title: string
}

export function SettingsSection({
  action,
  children,
  compact = false,
  description,
  error,
  errorFallback = 'Failed to load',
  onRetry,
  title,
}: Props) {
  const cardClass = compact
    ? 'bg-card flex flex-col gap-3 rounded-xl border px-4.5 py-3.5'
    : 'bg-card flex flex-col gap-4 rounded-xl border p-5'

  return (
    <div className="flex w-full flex-col gap-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <h2 className="text-foreground text-[0.95rem] font-semibold leading-tight">{title}</h2>
          <p className="text-muted-foreground mt-0.5 text-[0.8125rem] leading-snug">{description}</p>
        </div>
        {action}
      </div>

      {error ? (
        <div className="border-destructive/30 bg-destructive/5 flex items-center justify-between gap-3 rounded-xl border px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <AlertCircle className="text-destructive size-4 shrink-0" />
            <p className="text-foreground text-sm">{formatError(error, errorFallback)}</p>
          </div>
          {onRetry && (
            <Button className="shrink-0" onClick={onRetry} size="sm" variant="secondary">
              <RotateCw className="size-3.5" />
              Retry
            </Button>
          )}
        </div>
      ) : (
        children && <div className={cardClass}>{children}</div>
      )}
    </div>
  )
}

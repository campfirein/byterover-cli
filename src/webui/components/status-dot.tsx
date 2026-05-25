import {cn} from '@campfirein/byterover-packages/lib/utils'

export type Tone = 'amber' | 'destructive' | 'info' | 'success'

type Props = {
  className?: string
  /** When true, wrap the dot in a `ping`-animated halo to draw attention. */
  pulsing?: boolean
  tone: Tone
}

const TONE_BG: Record<Tone, string> = {
  amber: 'bg-amber-500',
  destructive: 'bg-destructive',
  info: 'bg-blue-500',
  success: 'bg-primary-foreground',
}

/**
 * Small colored dot for status annotations.
 *
 * - Default: a single solid dot — use for permanent indicators
 *   (e.g. "connected", "X unread").
 * - `pulsing`: dot wrapped in a `ping`-animated halo — use for exceptions
 *   that want attention (e.g. "configuration required").
 *
 * Default size is 6px; pass `size-*` via `className` to resize. `className`
 * can also add border/position utilities (e.g. overlaying as a corner badge
 * on an icon).
 */
export function StatusDot({className, pulsing = false, tone}: Props) {
  const bg = TONE_BG[tone]

  if (pulsing) {
    return (
      <span className={cn('relative inline-flex size-1.5 shrink-0', className)}>
        <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-75', bg)} />
        <span className={cn('relative inline-flex size-full rounded-full', bg)} />
      </span>
    )
  }

  return <span className={cn('inline-block size-1.5 shrink-0 rounded-full', bg, className)} />
}

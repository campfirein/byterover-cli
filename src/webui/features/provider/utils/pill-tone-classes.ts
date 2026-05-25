import type {BillingTone} from './get-billing-tone'

export const PILL_TONE_CLASSES: Record<BillingTone, string> = {
  danger: 'border-destructive/40 bg-destructive/15 text-destructive',
  inactive: 'border-border bg-muted text-muted-foreground',
  ok: 'border-primary-foreground/40 bg-primary-foreground/15 text-primary-foreground',
  warn: 'border-amber-500/50 bg-amber-500/15 text-amber-400',
}

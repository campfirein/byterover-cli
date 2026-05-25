import {Badge} from '@campfirein/byterover-packages/components/badge'
import {Skeleton} from '@campfirein/byterover-packages/components/skeleton'
import {cn} from '@campfirein/byterover-packages/lib/utils'

import {formatCredits} from '../utils/format-credits'
import {type BillingTone, type BillingToneInput} from '../utils/get-billing-tone'
import {PILL_TONE_CLASSES} from '../utils/pill-tone-classes'

export function CreditsPill({tone, usage}: {tone: BillingTone; usage?: BillingToneInput}) {
  if (!usage) return <Skeleton className="h-[18px] w-12 rounded-sm" />
  return (
    <Badge
      className={cn('mono h-[18px] rounded-sm px-1.5 text-[11px] font-medium leading-none', PILL_TONE_CLASSES[tone])}
      variant="outline"
    >
      {formatCredits(usage.remaining)} cr
    </Badge>
  )
}

import {Badge} from '@campfirein/byterover-packages/components/badge'
import {Button} from '@campfirein/byterover-packages/components/button'
import {DialogDescription, DialogHeader, DialogTitle} from '@campfirein/byterover-packages/components/dialog'
import {Input} from '@campfirein/byterover-packages/components/input'
import {cn} from '@campfirein/byterover-packages/lib/utils'
import {AlertTriangle, Check, Search} from 'lucide-react'
import {useMemo, useState} from 'react'

import type {ProviderDTO} from '../../../../../shared/transport/types/dto'

import {useGetEnvironmentConfig} from '../../../config/api/get-environment-config'
import {useGetPinnedTeam} from '../../api/get-pinned-team'
import {useListTeams} from '../../api/list-teams'
import {useBillingDisplay} from '../../hooks/use-billing-display'
import {buildTopUpUrl} from '../../utils/build-top-up-url'
import {formatCredits} from '../../utils/format-credits'
import {CreditsPill} from '../credits-pill'
import {providerIcons} from './provider-icons'

const BYTEROVER_PROVIDER_ID = 'byterover'

interface ProviderSelectStepProps {
  onSelect: (provider: ProviderDTO) => void
  providers: ProviderDTO[]
}

/**
 * Sort ByteRover to the top so it shows as the default choice. Everything else
 * keeps its server-side ordering.
 */
function orderProviders(providers: ProviderDTO[]): ProviderDTO[] {
  const byterover = providers.find((p) => p.id === BYTEROVER_PROVIDER_ID)
  if (!byterover) return providers
  return [byterover, ...providers.filter((p) => p.id !== BYTEROVER_PROVIDER_ID)]
}

function ExhaustedAlert({remaining, topUpUrl}: {remaining: number; topUpUrl?: string}) {
  return (
    <div className="border-destructive/40 bg-destructive/10 flex gap-2.5 rounded-md border px-3 py-2.5">
      <AlertTriangle className="text-destructive mt-0.5 size-4 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-foreground text-sm font-medium">ByteRover team is out of credits</span>
        <p className="text-muted-foreground text-xs leading-snug">
          {remaining <= 0
            ? 'Pick another team, top up, or switch to a bring-your-own-key provider below.'
            : `Only ${formatCredits(remaining)} credits remaining.`}
        </p>
      </div>
      {topUpUrl && (
        <Button
          className="shrink-0"
          onClick={() => window.open(topUpUrl, '_blank', 'noopener,noreferrer')}
          size="sm"
        >
          Top up
        </Button>
      )}
    </div>
  )
}

export function ProviderSelectStep({onSelect, providers}: ProviderSelectStepProps) {
  const [search, setSearch] = useState('')
  const {data: pinnedData} = useGetPinnedTeam()

  const byteRoverActive = useMemo(
    () => providers.find((p) => p.id === BYTEROVER_PROVIDER_ID && p.isCurrent),
    [providers],
  )
  const {billingSource: usage, billingTone, paidOrg} = useBillingDisplay({
    preferredOrgId: pinnedData?.teamId,
  })
  const isExhausted = byteRoverActive !== undefined && billingTone === 'danger' && usage !== undefined

  const {data: envConfig} = useGetEnvironmentConfig()
  const {data: teamsData} = useListTeams()
  const teamSlug = teamsData?.teams?.find((t) => t.id === paidOrg?.organizationId)?.slug
  const topUpUrl = buildTopUpUrl({teamSlug, webAppUrl: envConfig?.webAppUrl})

  const filtered = useMemo(() => {
    const ordered = orderProviders(providers)
    if (!search) return ordered
    const q = search.toLowerCase()
    return ordered.filter((p) => p.name.toLowerCase().includes(q))
  }, [providers, search])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <DialogHeader>
        <DialogTitle>Pick a provider to power curate &amp; query</DialogTitle>
        <DialogDescription>
          ByteRover routes LLM calls through your chosen provider. You can change this later.
        </DialogDescription>
      </DialogHeader>

      {isExhausted && usage && <ExhaustedAlert remaining={usage.remaining} topUpUrl={topUpUrl} />}

      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input className="pl-9" onChange={(e) => setSearch(e.target.value)} placeholder="Search..." value={search} />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-4 -mr-4 [scrollbar-gutter:stable]">
          {filtered.map((provider) => {
            const icon = providerIcons[provider.id]
            const isActive = provider.isCurrent
            const isByteRover = provider.id === BYTEROVER_PROVIDER_ID
            const showRowDanger = isByteRover && isActive && isExhausted

            return (
              <button
                className={cn(
                  'group/row flex w-full cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                  showRowDanger
                    ? 'border-destructive/40 bg-destructive/5'
                    : isActive
                      ? 'border-primary-foreground/40 bg-primary/5'
                      : 'border-border hover:border-foreground/25',
                )}
                key={provider.id}
                onClick={() => onSelect(provider)}
                title={provider.description}
                type="button"
              >
                <div className="bg-muted/50 grid size-7 shrink-0 place-items-center overflow-hidden rounded-md">
                  {icon && <img alt="" className="size-5" src={icon} />}
                </div>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="text-foreground flex flex-wrap items-center gap-1.5 text-sm">
                    <span className="font-medium truncate">{provider.name}</span>
                    {isByteRover && (
                      <Badge
                        className="border-amber-500/50 bg-amber-500/15 text-amber-400 h-[18px] rounded-sm px-1.5 text-[11px] font-medium leading-none"
                        variant="outline"
                      >
                        Native
                      </Badge>
                    )}
                    {isByteRover && (
                      <Badge
                        className="border-primary-foreground/40 bg-primary-foreground/15 text-primary-foreground h-[18px] rounded-sm px-1.5 text-[11px] font-medium leading-none"
                        variant="outline"
                      >
                        Credits included
                      </Badge>
                    )}
                    {isByteRover && isActive && usage && <CreditsPill tone={billingTone} usage={usage} />}
                  </div>
                  <div className="text-muted-foreground min-h-lh truncate text-xs">{provider.description}</div>
                </div>
                <div
                  className={cn(
                    'grid size-[18px] shrink-0 place-items-center rounded-full border transition-colors',
                    isActive ? 'bg-primary-foreground border-primary-foreground' : 'border-border',
                  )}
                >
                  {isActive && <Check className="text-background size-3" strokeWidth={3} />}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

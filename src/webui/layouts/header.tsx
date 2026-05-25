import {Badge} from '@campfirein/byterover-packages/components/badge'
import {Button} from '@campfirein/byterover-packages/components/button'
import {Tooltip, TooltipContent, TooltipTrigger} from '@campfirein/byterover-packages/components/tooltip'
import {cn} from '@campfirein/byterover-packages/lib/utils'
import {Plug} from 'lucide-react'
import {useState} from 'react'

import logo from '../assets/logo-byterover.svg'
import {StatusDot, type Tone as StatusDotTone} from '../components/status-dot'
import {AuthMenu} from '../features/auth/components/auth-menu'
import {useGetEnvironmentConfig} from '../features/config/api/get-environment-config'
import {HelpMenu} from '../features/onboarding/components/help-menu'
import {ProjectDropdown} from '../features/project/components/project-dropdown'
import {useGetActiveProviderConfig} from '../features/provider/api/get-active-provider-config'
import {useGetPinnedTeam} from '../features/provider/api/get-pinned-team'
import {useGetProviders} from '../features/provider/api/get-providers'
import {useListTeams} from '../features/provider/api/list-teams'
import {ProviderFlowDialog} from '../features/provider/components/provider-flow'
import {useBillingDisplay} from '../features/provider/hooks/use-billing-display'
import {buildProviderLabel} from '../features/provider/utils/build-provider-label'
import {buildTopUpUrl} from '../features/provider/utils/build-top-up-url'
import {formatCredits} from '../features/provider/utils/format-credits'
import {type BillingTone} from '../features/provider/utils/get-billing-tone'
import {PILL_TONE_CLASSES} from '../features/provider/utils/pill-tone-classes'
import {BranchDropdown} from '../features/vc/components/branch-dropdown'
import {useTransportStore} from '../stores/transport-store'

const BYTEROVER_PROVIDER_ID = 'byterover'

const STATUS_DOT_TONE: Record<BillingTone, StatusDotTone> = {
  danger: 'destructive',
  inactive: 'success',
  ok: 'success',
  warn: 'amber',
}

const TRIGGER_TONE_CLASS: Record<BillingTone, string> = {
  danger: 'text-destructive hover:text-destructive',
  inactive: '',
  ok: '',
  warn: 'text-amber-400 hover:text-amber-400',
}

function CreditPill({remaining, tone}: {remaining: number; tone: BillingTone}) {
  return (
    <span
      className={cn(
        'mono inline-flex h-[18px] items-center rounded-full border px-1.5 text-[10px] leading-none',
        PILL_TONE_CLASSES[tone],
      )}
    >
      {formatCredits(remaining)}
    </span>
  )
}

export function Header() {
  const version = useTransportStore((s) => s.version)
  const [providerDialogOpen, setProviderDialogOpen] = useState(false)
  const {data: providersData} = useGetProviders()
  const {data: activeConfig} = useGetActiveProviderConfig()
  const {data: pinnedData} = useGetPinnedTeam()

  const activeProvider = providersData?.providers.find((p) => p.isCurrent)
  const isByteRoverActive = activeProvider?.id === BYTEROVER_PROVIDER_ID
  const providerLabel = buildProviderLabel(activeProvider, activeConfig)

  const {data: teamsData} = useListTeams()

  const {billingSource, billingTone, needsPickPrompt, paidOrg, showCreditPill: hasBillingData} = useBillingDisplay({
    preferredOrgId: pinnedData?.teamId,
  })
  const showCreditPill = isByteRoverActive && hasBillingData

  const {data: envConfig} = useGetEnvironmentConfig()
  const teamSlug = teamsData?.teams?.find((t) => t.id === paidOrg?.organizationId)?.slug
  const topUpUrl = buildTopUpUrl({teamSlug, webAppUrl: envConfig?.webAppUrl})

  const needsAttention = !activeProvider || (isByteRoverActive && needsPickPrompt)
  let triggerToneClass = ''
  if (needsAttention) triggerToneClass = TRIGGER_TONE_CLASS.warn
  else if (isByteRoverActive) triggerToneClass = TRIGGER_TONE_CLASS[billingTone]

  return (
    <header className="flex items-center gap-4 px-6 py-3.5">
      {/* Left: logo + project + branch */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 mr-2.5">
          <img alt="ByteRover" className="w-32" src={logo} />
          {version && <span className="text-primary-foreground text-xs font-medium">v{version}</span>}
        </div>

        <ProjectDropdown />

        <BranchDropdown />

        <Tooltip>
          <TooltipTrigger
            render={
              <Badge
                className="border-primary-foreground/40 bg-primary-foreground/15 text-primary-foreground mono gap-1 px-1.5 text-[9px] leading-none font-semibold tracking-[0.16em] uppercase"
                variant="outline"
              />
            }
          >
            <span aria-hidden className="bg-primary-foreground size-1 shrink-0 rounded-full" />
            <span className="leading-none">Local</span>
          </TooltipTrigger>
          <TooltipContent>You're viewing the local web UI, served from the daemon on your machine.</TooltipContent>
        </Tooltip>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right: provider/model + docs + login */}
      <div className="flex items-center gap-3">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                className={cn('whitespace-nowrap', triggerToneClass)}
                onClick={() => setProviderDialogOpen(true)}
                size="sm"
                variant="ghost"
              />
            }
          >
            <span className="relative mr-1 inline-flex size-4 shrink-0">
              <Plug className="size-4" />
              {activeProvider && (
                <StatusDot
                  className="border-background absolute -right-0.5 -bottom-0.5 size-2 border-2"
                  tone={
                    isByteRoverActive && needsPickPrompt
                      ? 'amber'
                      : (isByteRoverActive ? STATUS_DOT_TONE[billingTone] : 'success')
                  }
                />
              )}
            </span>
            {providerLabel}
            {showCreditPill && billingSource && <CreditPill remaining={billingSource.remaining} tone={billingTone} />}
            {needsAttention && <StatusDot className="ml-1" pulsing tone="amber" />}
          </TooltipTrigger>
          {!activeProvider && <TooltipContent>Configure provider to power curate & query</TooltipContent>}
          {showCreditPill && billingTone === 'danger' && (
            <TooltipContent>
              <span>Out of credits.</span>{' '}
              {topUpUrl ? (
                <a
                  className="text-primary-foreground hover:underline"
                  href={topUpUrl}
                  onClick={(e) => e.stopPropagation()}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  Top up
                </a>
              ) : (
                <span>Switch team, top up, or use a bring-your-own-key provider.</span>
              )}
            </TooltipContent>
          )}
          {showCreditPill && billingSource && billingTone === 'warn' && (
            <TooltipContent>
              Running low on credits — {formatCredits(billingSource.remaining)} remaining.
            </TooltipContent>
          )}
          {isByteRoverActive && needsPickPrompt && billingTone !== 'danger' && billingTone !== 'warn' && (
            <TooltipContent>Select a team to bill your usage to.</TooltipContent>
          )}
        </Tooltip>
        <ProviderFlowDialog onOpenChange={setProviderDialogOpen} open={providerDialogOpen} />

        <HelpMenu />

        <AuthMenu />
      </div>
    </header>
  )
}

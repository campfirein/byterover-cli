import {Badge} from '@campfirein/byterover-packages/components/badge'
import {Button} from '@campfirein/byterover-packages/components/button'
import {DialogDescription, DialogHeader, DialogTitle} from '@campfirein/byterover-packages/components/dialog'
import {Skeleton} from '@campfirein/byterover-packages/components/skeleton'
import {cn} from '@campfirein/byterover-packages/lib/utils'
import {Check, ChevronLeft, LoaderCircle} from 'lucide-react'
import {ReactNode, useEffect, useMemo, useState} from 'react'
import {toast} from 'sonner'

import type {BillingTier, TeamDTO} from '../../../../../shared/transport/types/dto'

import {formatError} from '../../../../lib/error-messages'
import {initials} from '../../../../utils/initials'
import {useAuthStore} from '../../../auth/stores/auth-store'
import {useGetPinnedTeam} from '../../api/get-pinned-team'
import {useListBillingUsage} from '../../api/list-billing-usage'
import {useListTeams} from '../../api/list-teams'
import {useSetPinnedTeam} from '../../api/set-pinned-team'
import {computeTeamPreselection} from '../../utils/compute-team-preselection'
import {getBillingTone} from '../../utils/get-billing-tone'
import {getPaidOrganizationIds, hasPaidTeam} from '../../utils/has-paid-team'
import {CreditsPill} from '../credits-pill'

interface TeamSelectStepProps {
  onBack: () => void
  onComplete: () => void
}

function TeamRow({
  avatar,
  badges,
  credits,
  meta,
  name,
  onSelect,
  selected,
}: {
  avatar: ReactNode
  badges?: ReactNode
  credits?: ReactNode
  meta?: string
  name: string
  onSelect: () => void
  selected: boolean
}) {
  return (
    <button
      className={cn(
        'group/row flex w-full cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
        selected ? 'border-primary-foreground/40 bg-primary/5' : 'border-border hover:border-foreground/25',
      )}
      onClick={onSelect}
      type="button"
    >
      {avatar}
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-foreground flex flex-wrap items-center gap-1.5 text-sm">
          <span className="font-medium truncate">{name}</span>
          {badges}
        </div>
        {meta && <div className="text-muted-foreground min-h-lh truncate text-xs">{meta}</div>}
      </div>
      {credits}
      <div
        className={cn(
          'grid size-4.5 shrink-0 place-items-center rounded-full border transition-colors',
          selected ? 'bg-primary-foreground border-primary-foreground' : 'border-border',
        )}
      >
        {selected && <Check className="text-background size-3" strokeWidth={3} />}
      </div>
    </button>
  )
}

function BackButton({onBack}: {onBack: () => void}) {
  return (
    <button
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 self-start text-xs"
      onClick={onBack}
      type="button"
    >
      <ChevronLeft className="size-3" /> Back
    </button>
  )
}

function TeamAvatar({avatarUrl, name}: {avatarUrl?: string; name: string}) {
  return (
    <div className="bg-muted/50 grid size-7 shrink-0 place-items-center overflow-hidden rounded-md">
      {avatarUrl ? (
        <img alt="" className="size-full object-cover" src={avatarUrl} />
      ) : (
        <span className="text-muted-foreground text-[10px] font-medium">{initials(name)}</span>
      )}
    </div>
  )
}

const TIER_LABEL: Record<BillingTier, string> = {
  FREE: 'Free',
  PRO: 'Pro',
  TEAM: 'Team',
}

const TIER_BADGE_CLASS: Record<BillingTier, string> = {
  FREE: 'border-gray-700 bg-gray-900 text-gray-300',
  PRO: 'border-orange-800 bg-orange-950 text-orange-400',
  TEAM: 'border-blue-800 bg-blue-950 text-blue-400',
}

function RowBadge({children, className}: {children: ReactNode; className?: string}) {
  return (
    <Badge
      className={cn(
        'h-4.5 rounded-sm px-1.5 text-[11px] font-medium leading-none',
        className ?? 'border-primary-foreground/40 bg-primary-foreground/15 text-primary-foreground',
      )}
      variant="outline"
    >
      {children}
    </Badge>
  )
}

function TierBadge({isTrialing, tier}: {isTrialing: boolean; tier: BillingTier}) {
  return (
    <RowBadge className={TIER_BADGE_CLASS[tier]}>
      {TIER_LABEL[tier]}
      {isTrialing ? ' · trial' : ''}
    </RowBadge>
  )
}

export function TeamSelectStep({onBack, onComplete}: TeamSelectStepProps) {
  const workspaceTeamId = useAuthStore((s) => s.brvConfig?.teamId)

  const {data: teamsData, error: teamsError, isLoading: teamsLoading} = useListTeams()
  const {data: pinnedData, isLoading: pinnedLoading} = useGetPinnedTeam()
  const setPinned = useSetPinnedTeam()

  const teams: TeamDTO[] = teamsData?.teams ?? []
  const {data: usageData} = useListBillingUsage()
  const usageByTeam = useMemo(() => usageData?.usage ?? {}, [usageData?.usage])

  const pinnedOrganizationId = pinnedData?.teamId
  const paidOrganizationIds = useMemo(() => getPaidOrganizationIds(usageByTeam), [usageByTeam])

  const preselection = useMemo(
    () =>
      computeTeamPreselection({
        paidOrganizationIds,
        pinnedTeamId: pinnedOrganizationId,
        teams,
        workspaceTeamId,
      }),
    [paidOrganizationIds, pinnedOrganizationId, teams, workspaceTeamId],
  )

  const [selection, setSelection] = useState<string | undefined>(preselection)
  useEffect(() => {
    setSelection(preselection)
  }, [preselection])

  const isPersisting = setPinned.isPending
  const isLoading = teamsLoading || pinnedLoading
  const dirty = selection !== pinnedOrganizationId
  const selectionInList = selection !== undefined && teams.some((t) => t.id === selection)
  const canConfirm = dirty && selectionInList && !isPersisting

  const showFreeTierView = !isLoading && !teamsError && !hasPaidTeam(usageByTeam)

  async function confirm() {
    if (selection === undefined) return
    try {
      const result = await setPinned.mutateAsync(selection)
      if (!result.success) {
        toast.error(result.error ?? 'Failed to update billing team.')
        return
      }

      const selectedTeam = teams.find((t) => t.id === selection)
      toast.success(`ByteRover usage will be billed to ${selectedTeam?.displayName ?? selection}.`)
      onComplete()
    } catch (error) {
      toast.error(formatError(error, 'Failed to update billing team.'))
    }
  }

  if (showFreeTierView) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-5">
        <DialogHeader>
          <BackButton onBack={onBack} />
          <DialogTitle>ByteRover billing</DialogTitle>
          <DialogDescription>
            You don&apos;t belong to any paid teams. ByteRover usage uses your free monthly credits.
          </DialogDescription>
        </DialogHeader>

        <div className="border-border mt-auto flex items-center justify-end gap-2 border-t pt-3">
          <Button onClick={onComplete}>Got it</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <DialogHeader>
        <BackButton onBack={onBack} />
        <DialogTitle>Pick a team to bill</DialogTitle>
        <DialogDescription>
          ByteRover credits are charged to a team. Pick which team this project should bill.
        </DialogDescription>
      </DialogHeader>

      {teamsError ? (
        <p className="text-destructive text-sm">{formatError(teamsError, 'Failed to load teams.')}</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-4 -mr-4 [scrollbar-gutter:stable]">
          {isLoading && teams.length === 0 ? (
            <>
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </>
          ) : (
            teams.map((team) => {
              const teamUsage = usageByTeam[team.id]
              const roleLabel = team.id === workspaceTeamId ? 'Workspace' : team.isDefault ? 'Default' : undefined
              return (
                <TeamRow
                  avatar={<TeamAvatar avatarUrl={team.avatarUrl} name={team.displayName} />}
                  badges={
                    <>
                      {teamUsage && <TierBadge isTrialing={teamUsage.isTrialing} tier={teamUsage.tier} />}
                      {roleLabel && <RowBadge>{roleLabel}</RowBadge>}
                    </>
                  }
                  credits={<CreditsPill tone={getBillingTone(teamUsage)} usage={teamUsage} />}
                  key={team.id}
                  name={team.displayName}
                  onSelect={() => setSelection(team.id)}
                  selected={selection === team.id}
                />
              )
            })
          )}
        </div>
      )}

      <div className="border-border flex items-center justify-end gap-2 border-t pt-3">
        <Button disabled={!canConfirm} onClick={() => confirm()}>
          {isPersisting ? <LoaderCircle className="size-4 animate-spin" /> : 'Confirm'}
        </Button>
      </div>
    </div>
  )
}

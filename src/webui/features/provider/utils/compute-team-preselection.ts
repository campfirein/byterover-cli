import type {TeamDTO} from '../../../../shared/transport/types/dto'

export function computeTeamPreselection(args: {
  paidOrganizationIds: readonly string[]
  pinnedTeamId?: string
  teams: readonly TeamDTO[]
  workspaceTeamId?: string
}): string | undefined {
  const {paidOrganizationIds, pinnedTeamId, teams, workspaceTeamId} = args

  if (pinnedTeamId && teams.some((t) => t.id === pinnedTeamId)) {
    return pinnedTeamId
  }

  if (paidOrganizationIds.length === 0) return undefined
  if (paidOrganizationIds.length === 1) return paidOrganizationIds[0]

  if (workspaceTeamId) return workspaceTeamId

  return undefined
}

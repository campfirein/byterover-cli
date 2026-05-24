import type {TeamDTO} from '../../../../shared/transport/types/dto.js'
import type {ITeamService} from '../../../core/interfaces/services/i-team-service.js'
import type {IAuthStateStore} from '../../../core/interfaces/state/i-auth-state-store.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {TeamEvents, type TeamListResponse} from '../../../../shared/transport/events/team-events.js'
import {getErrorMessage} from '../../../utils/error-helpers.js'

export interface TeamHandlerDeps {
  authStateStore: IAuthStateStore
  teamService: ITeamService
  transport: ITransportServer
}

const NOT_AUTHENTICATED_ERROR = 'Listing teams requires sign-in. Run /login or brv login to sign in.'

/**
 * Handles team:* events. Exposes the user's teams to clients (webui) so they
 * can render team pickers without each client re-implementing the IAM call.
 */
export class TeamHandler {
  private readonly authStateStore: IAuthStateStore
  private readonly teamService: ITeamService
  private readonly transport: ITransportServer

  constructor(deps: TeamHandlerDeps) {
    this.authStateStore = deps.authStateStore
    this.teamService = deps.teamService
    this.transport = deps.transport
  }

  setup(): void {
    this.transport.onRequest<undefined, TeamListResponse>(TeamEvents.LIST, async () => {
      const token = this.authStateStore.getToken()
      if (!token?.isValid()) {
        return {error: NOT_AUTHENTICATED_ERROR}
      }

      try {
        const {teams} = await this.teamService.getTeams(token.sessionKey, {fetchAll: true})
        const dtos: TeamDTO[] = teams.map((team) => ({
          avatarUrl: team.avatarUrl,
          displayName: team.displayName,
          id: team.id,
          isDefault: team.isDefault,
          name: team.name,
          slug: team.slug,
        }))
        return {teams: dtos}
      } catch (error) {
        return {error: getErrorMessage(error)}
      }
    })
  }
}

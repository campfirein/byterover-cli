import {Command, Flags} from '@oclif/core'
import chalk from 'chalk'

import type {StatusBillingDTO, TeamDTO} from '../../../shared/transport/types/dto.js'

import {BillingEvents, type BillingResolveResponse} from '../../../shared/transport/events/billing-events.js'
import {ProviderEvents, type ProviderListResponse} from '../../../shared/transport/events/provider-events.js'
import {TeamEvents, type TeamListResponse} from '../../../shared/transport/events/team-events.js'
import {type DaemonClientOptions, formatConnectionError, withDaemonRetry} from '../../lib/daemon-client.js'
import {writeJsonResponse} from '../../lib/json-response.js'

const BYTEROVER_PROVIDER_ID = 'byterover'

interface ProvidersListData {
  billing?: StatusBillingDTO
  providers: ProviderListResponse['providers']
  teams: TeamDTO[]
}

const EMPTY_TEAMS: TeamListResponse = {teams: []}

export default class ProviderList extends Command {
  public static description = 'List all available providers and their connection status'
  public static examples = ['<%= config.bin %> providers list', '<%= config.bin %> providers list --format json']
  public static flags = {
    format: Flags.string({
      default: 'text',
      description: 'Output format (text or json)',
      options: ['text', 'json'],
    }),
  }

  protected billingMarker(teamId: string, billing?: StatusBillingDTO): string | undefined {
    if (billing?.source !== 'paid') return undefined
    if (billing.organizationId !== teamId) return undefined
    return 'billing'
  }

  protected async fetchAll(options?: DaemonClientOptions): Promise<ProvidersListData> {
    return withDaemonRetry(async (client) => {
      const {providers} = await client.requestWithAck<ProviderListResponse>(ProviderEvents.LIST)
      const byterover = providers.find((p) => p.id === BYTEROVER_PROVIDER_ID)
      if (!byterover?.isConnected) return {providers, teams: []}

      const [teamsResponse, billingResponse] = await Promise.all([
        client.requestWithAck<TeamListResponse>(TeamEvents.LIST).catch(() => EMPTY_TEAMS),
        client.requestWithAck<BillingResolveResponse>(BillingEvents.RESOLVE).catch(() => {}),
      ])
      return {billing: billingResponse?.billing, providers, teams: teamsResponse.teams ?? []}
    }, options)
  }

  protected printByteRoverTeams(teams: readonly TeamDTO[], billing?: StatusBillingDTO): void {
    this.log(`    ${chalk.dim('Your teams:')}`)
    for (const team of teams) {
      const marker = this.billingMarker(team.id, billing)
      const suffix = marker ? ` ${chalk.dim(`(${marker})`)}` : ''
      this.log(`      ${team.displayName}${suffix}`)
    }
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(ProviderList)
    const format = flags.format as 'json' | 'text'

    try {
      const {billing, providers, teams} = await this.fetchAll()

      if (format === 'json') {
        writeJsonResponse({command: 'providers list', data: {providers}, success: true})
        return
      }

      for (const p of providers) {
        const status = p.isCurrent ? chalk.green('(current)') : p.isConnected ? chalk.yellow('(connected)') : ''
        const authBadge =
          p.authMethod === 'oauth' ? chalk.cyan('[OAuth]') : p.authMethod === 'api-key' ? chalk.dim('[API Key]') : ''
        this.log(`  ${p.name} [${p.id}] ${status} ${authBadge}`.trimEnd())
        if (p.description) {
          this.log(`    ${chalk.dim(p.description)}`)
        }

        if (p.id === BYTEROVER_PROVIDER_ID && p.isConnected && teams.length > 0) {
          this.printByteRoverTeams(teams, billing)
        }
      }
    } catch (error) {
      if (format === 'json') {
        writeJsonResponse({command: 'providers list', data: {error: formatConnectionError(error)}, success: false})
      } else {
        this.log(formatConnectionError(error))
      }
    }
  }
}

import {Args, Command, Flags} from '@oclif/core'

import type {
  ChannelProfileShowRequest,
  ChannelProfileShowResponse,
} from '../../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../../shared/transport/events/channel-events.js'
import {ChannelClientError, withChannelClient} from '../../../lib/channel-client.js'

export default class ChannelProfileShow extends Command {
  public static args = {
    name: Args.string({description: 'Profile name', required: true}),
  }
public static description = 'Inspect a driver profile by name (Phase 3)'
public static examples = ['<%= config.bin %> <%= command.id %> mock', '<%= config.bin %> <%= command.id %> mock --json']
public static flags = {
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelProfileShow)
    try {
      const response = await withChannelClient(async (client) =>
        client.request<ChannelProfileShowRequest, ChannelProfileShowResponse>(
          ChannelEvents.PROFILE_SHOW,
          {name: args.name},
        ),
      )

      if (flags.json) {
        this.log(JSON.stringify(response, undefined, 2))
        return
      }

      const {driftObservations, profile, recentTurnDurations} = response
      this.log(`${profile.name} (${profile.displayName})`)
      this.log(`  driver class: ${profile.driverClass}`)
      this.log(`  invocation:   ${profile.invocation.command} ${profile.invocation.args.join(' ')}`)
      if (profile.detectedAcpVersion !== undefined) this.log(`  acpVersion:   ${profile.detectedAcpVersion}`)
      if (profile.capabilities?.length) this.log(`  capabilities: ${profile.capabilities.join(', ')}`)
      if (profile.probedAt !== undefined) this.log(`  probedAt:     ${profile.probedAt}`)
      // Phase 10 Tier B3 — render drift observations (V6 run-3 §4a). When
      // present, surfaces "known drift" so the orchestrator tightens the
      // contract before re-dispatching.
      if (driftObservations !== undefined && driftObservations.length > 0) {
        this.log(`  drift observations:`)
        for (const obs of driftObservations) {
          const loc = obs.line === undefined ? obs.file : `${obs.file}:${obs.line}`
          this.log(`    • ${loc} — ${obs.description} (observed ${obs.observedAt})`)
        }
      }

      // Phase 10 Tier C #4 — render per-agent wall-clock variance (V6
      // run-4 §4b). Surfaces median + min/max of recent completed
      // turns so the orchestrator sees pi's 60s → 12min spread before
      // dispatching the next prompt.
      if (recentTurnDurations !== undefined && recentTurnDurations.length > 0) {
        const sortedMs = [...recentTurnDurations].map((e) => e.durationMs).sort((a, b) => a - b)
        const min = sortedMs[0]
        const max = sortedMs.at(-1) ?? min
        const median = sortedMs[Math.floor(sortedMs.length / 2)]
        const fmt = (ms: number): string => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`)
        this.log(`  recent turn durations (n=${recentTurnDurations.length}): median ${fmt(median)} (min ${fmt(min)}, max ${fmt(max)})`)
      }
    } catch (error) {
      this.handleError(error, flags.json)
    }
  }

  private handleError(error: unknown, asJson: boolean): never {
    if (error instanceof ChannelClientError) {
      if (asJson) {
        this.log(JSON.stringify({code: error.code, error: error.message, success: false}))
      } else {
        this.logToStderr(`[${error.code}] ${error.message}`)
      }

      this.exit(1)
    }

    throw error
  }
}

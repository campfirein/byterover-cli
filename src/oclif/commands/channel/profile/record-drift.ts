import {Args, Command, Flags} from '@oclif/core'

import type {
  ChannelProfileClearDriftRequest,
  ChannelProfileClearDriftResponse,
  ChannelProfileRecordDriftRequest,
  ChannelProfileRecordDriftResponse,
} from '../../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../../shared/transport/events/channel-events.js'
import {ChannelClientError, withChannelClient} from '../../../lib/channel-client.js'

// Phase 10 Tier B3 (V6 run-3 §4a) — record a per-handle drift observation
// so `channel profile show <name>` surfaces "known drift" upfront.
//
// V6 run-3 caught @pi reproducing the same `-100` cull deviation at
// systems.js:159 across two runs. Recording that observation lets the
// orchestrator tighten the contract on that specific point before
// re-dispatching (see SKILL.md "Contract strength → defect prevention").
export default class ChannelProfileRecordDrift extends Command {
  public static args = {
    description: Args.string({
      description: 'Short description of the spec deviation (e.g. "used -100 vs spec -50 for off-screen cull")',
      required: false,
    }),
    name: Args.string({description: 'Profile name (e.g. kimi, codex, opencode, pi)', required: true}),
  }
public static description = `Record a per-profile drift observation (Phase 10 Tier B3).

A drift observation pins "this agent reproduced this specific deviation
from spec at this file:line." Future \`channel profile show <name>\`
calls surface these so the orchestrator can tighten the contract on
that point before re-dispatching.

Use --clear (without other args beyond name) to wipe all observations
for a profile.`
public static examples = [
    '<%= config.bin %> <%= command.id %> pi "used -100 vs spec -50 for off-screen cull" --file systems.js --line 159',
    '<%= config.bin %> <%= command.id %> pi --clear',
    '<%= config.bin %> <%= command.id %> codex "R-key handler omitted preventDefault" --file engine.js',
  ]
public static flags = {
    clear: Flags.boolean({
      default: false,
      description: 'Clear ALL drift observations for this profile (ignores --file, --line, and the description argument)',
    }),
    file: Flags.string({
      description: 'Source file the deviation occurred in (e.g. systems.js)',
    }),
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
    line: Flags.integer({
      description: 'Line number where the deviation occurred',
      min: 0,
    }),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelProfileRecordDrift)

    try {
      await withChannelClient(async (client) => {
        if (flags.clear) {
          const response = await client.request<ChannelProfileClearDriftRequest, ChannelProfileClearDriftResponse>(
            ChannelEvents.PROFILE_CLEAR_DRIFT,
            {name: args.name},
          )
          if (flags.json) {
            this.log(JSON.stringify(response, undefined, 2))
          } else {
            this.log(response.cleared ? `Cleared drift observations for ${args.name}.` : `No drift observations to clear for ${args.name}.`)
          }

          return
        }

        if (args.description === undefined || args.description === '') {
          throw new ChannelClientError(
            'CHANNEL_INVALID_REQUEST',
            'A description argument is required unless --clear is set.',
          )
        }

        if (flags.file === undefined) {
          throw new ChannelClientError(
            'CHANNEL_INVALID_REQUEST',
            '--file is required when recording a new observation.',
          )
        }

        const response = await client.request<ChannelProfileRecordDriftRequest, ChannelProfileRecordDriftResponse>(
          ChannelEvents.PROFILE_RECORD_DRIFT,
          {
            description: args.description,
            file: flags.file,
            ...(flags.line === undefined ? {} : {line: flags.line}),
            name: args.name,
          },
        )

        if (flags.json) {
          this.log(JSON.stringify(response, undefined, 2))
        } else {
          this.log(`Recorded drift observation for ${args.name} (total: ${response.observationCount}).`)
        }
      })
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

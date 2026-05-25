import {Args, Command, Flags} from '@oclif/core'

import type {
  ChannelDoctorRequest,
  ChannelDoctorResponse,
} from '../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelClientError, withChannelClient} from '../../lib/channel-client.js'

export default class ChannelDoctor extends Command {
  public static args = {
    channelId: Args.string({description: 'Channel handle to diagnose (optional)'}),
  }
public static description = 'Diagnose a channel, member, or profile (Phase 3)'
public static examples = [
    '<%= config.bin %> <%= command.id %> pi-test',
    '<%= config.bin %> <%= command.id %> pi-test --json',
    '<%= config.bin %> <%= command.id %> --profile mock',
  ]
public static flags = {
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
    member: Flags.string({description: 'Limit diagnostics to a specific member handle'}),
    profile: Flags.string({description: 'Diagnose a driver profile by name'}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelDoctor)

    try {
      const response = await withChannelClient(async (client) =>
        client.request<ChannelDoctorRequest, ChannelDoctorResponse>(ChannelEvents.DOCTOR, {
          channelId: args.channelId,
          memberHandle: flags.member,
          profileName: flags.profile,
        }),
      )

      if (flags.json) {
        this.log(JSON.stringify(response, undefined, 2))
        return
      }

      const header = args.channelId === undefined
        ? `Diagnostics`
        : `Channel #${args.channelId} — diagnostics`
      this.log(header)
      let errors = 0
      for (const d of response.diagnostics) {
        const tag = d.severity === 'error' ? '[error]  ' : d.severity === 'warning' ? '[warning]' : '[info]   '
        this.log(`  ${tag} ${d.message}`)
        if (d.severity === 'error') errors += 1
      }

      if (errors === 0) this.log('✓ no errors')
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

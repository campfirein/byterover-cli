import {Args, Flags} from '@oclif/core'

import type {ChannelOnboardResponse} from '../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelCommand} from '../../lib/channel-command.js'

export default class ChannelOnboard extends ChannelCommand {
  public static args = {
    name: Args.string({description: 'Profile name (used by `brv channel invite --profile <name>`)', required: true}),
  }
  public static description = 'Probe an ACP agent and save a reusable driver profile'
  public static examples = ['<%= config.bin %> <%= command.id %> mock -- node test/fixtures/mock-acp.js']
  public static flags = {
    'display-name': Flags.string({description: 'Friendly display name (defaults to the profile name)'}),
  }
  // Accept the trailing invocation tokens after `--`.
  public static strict = false

  public async run(): Promise<void> {
    const {args, argv, flags} = await this.parse(ChannelOnboard)
    const tail = argv.slice(1).filter((token): token is string => typeof token === 'string')
    if (tail.length === 0) {
      this.error('Inline invocation is required: `brv channel onboard <name> -- <command> [args...]`', {exit: 1})
    }

    const [command, ...commandArgs] = tail
    await this.dispatchAndRender<ChannelOnboardResponse>({
      asJson: flags.json,
      event: ChannelEvents.ONBOARD,
      payload: {
        displayName: flags['display-name'] ?? args.name,
        invocation: {args: commandArgs, command, cwd: process.cwd()},
        profileName: args.name,
      },
      render: (response) => {
        const caps = response.profile.capabilities?.length
          ? `, capabilities: [${response.profile.capabilities.join(', ')}]`
          : ''
        this.log(`✓ Profile \`${response.profile.name}\` saved (class: ${response.profile.driverClass}${caps})`)
      },
    })
  }
}

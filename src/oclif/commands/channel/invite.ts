import {Args, Command, Flags} from '@oclif/core'

import type {
  ChannelInviteRequest,
  ChannelInviteResponse,
} from '../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelClientError, withChannelClient} from '../../lib/channel-client.js'

export default class ChannelInvite extends Command {
  public static args = {
    channelId: Args.string({description: 'Channel handle', required: true}),
    handle: Args.string({description: 'Member handle (must start with @)', required: true}),
  }
public static description = 'Invite a local ACP agent OR a remote brv install into a channel'
public static examples = [
    '<%= config.bin %> <%= command.id %> pi-test @mock -- node test/fixtures/mock-acp.js',
    '<%= config.bin %> <%= command.id %> pi-test @kimi -- kimi acp',
    '<%= config.bin %> <%= command.id %> pi-test @mock --profile mock',
    '<%= config.bin %> <%= command.id %> review-2026 @bob --peer 12D3KooW... --multiaddr /ip4/.../tcp/4001/p2p/12D3KooW...',
  ]
public static flags = {
    'display-name': Flags.string({description: 'Display name to render alongside the remote-peer handle (optional)'}),
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
    'l2-pub-key': Flags.string({
      description:
        'Phase 9 remote-peer OPTIONAL fallback: base64 of the remote\'s L2 tree pubkey. ' +
        'Slice 9.4d makes this optional — the daemon auto-discovers it via the remote\'s ' +
        '`/brv/identity/tree-cert/v1` protocol when omitted. Supply this flag to override ' +
        'in-band discovery or to invite legacy peers that don\'t serve the sister protocol.',
    }),
    multiaddr: Flags.string({
      description: 'Phase 9 remote-peer: full multiaddr with /p2p/<peer-id> suffix of the remote brv install',
    }),
    peer: Flags.string({
      description: 'Phase 9 remote-peer: base58btc peer_id of the remote brv install',
    }),
    profile: Flags.string({description: 'Use a persisted driver profile name (Phase 3) instead of an inline invocation'}),
  }
// Accept the trailing invocation tokens (after `--`).
  public static strict = false

  public async run(): Promise<void> {
    const {args, argv, flags} = await this.parse(ChannelInvite)
    if (!args.handle.startsWith('@')) {
      this.error(`Member handle must start with @ (got "${args.handle}")`, {exit: 1})
    }

    // After the two named args (`channelId`, `handle`) the remaining argv is
    // the inline invocation: command + args. Oclif strips the leading `--`
    // separator before us, so argv[0] is the first invocation token.
    const tail = argv.slice(2).filter((v): v is string => typeof v === 'string')

    const isRemotePeer = flags.peer !== undefined || flags.multiaddr !== undefined || flags['l2-pub-key'] !== undefined

    let payload: ChannelInviteRequest
    if (isRemotePeer) {
      if (flags.profile !== undefined || tail.length > 0) {
        this.error(
          'Remote-peer flags (--peer / --multiaddr / --l2-pub-key) cannot be combined with --profile or an inline invocation',
          {exit: 1},
        )
      }

      // Slice 9.4d — `--l2-pub-key` is now OPTIONAL. The daemon
      // auto-discovers it via the remote's `/brv/identity/tree-cert/v1`
      // protocol. `--peer` + `--multiaddr` remain required.
      if (flags.peer === undefined || flags.multiaddr === undefined) {
        this.error('Remote-peer invite requires --peer and --multiaddr (--l2-pub-key optional; daemon auto-discovers)', {exit: 1})
      }

      payload = {
        channelId: args.channelId,
        handle: args.handle,
        remotePeer: {
          multiaddr: flags.multiaddr,
          peerId: flags.peer,
          ...(flags['l2-pub-key'] === undefined ? {} : {remoteL2PubKey: flags['l2-pub-key']}),
          ...(flags['display-name'] === undefined ? {} : {displayName: flags['display-name']}),
        },
      }
    } else if (flags.profile === undefined) {
      if (tail.length === 0) {
        this.error(
          'Invocation is required: `brv channel invite <ch> <@h> -- <command> [args...]` OR `--profile <name>` OR `--peer <id> --multiaddr <ma>` (--l2-pub-key optional in 9.4d+)',
          {exit: 1},
        )
      }

      const [command, ...commandArgs] = tail
      payload = {
        channelId: args.channelId,
        handle: args.handle,
        invocation: {args: commandArgs, command, cwd: process.cwd()},
      }
    } else {
      if (tail.length > 0) {
        this.error('Use either --profile <name> OR inline `-- <command>`, not both.', {exit: 1})
      }

      payload = {channelId: args.channelId, handle: args.handle, profileName: flags.profile}
    }

    try {
      const response = await withChannelClient(async (client) =>
        client.request<ChannelInviteRequest, ChannelInviteResponse>(ChannelEvents.INVITE, payload),
      )

      if (flags.json) {
        this.log(JSON.stringify(response, undefined, 2))
        return
      }

      const {member} = response
      if (member.memberKind === 'remote-peer') {
        this.log(`✓ Member ${args.handle} joined #${args.channelId} (remote-peer: ${member.peerId})`)
        this.log(`    multiaddr: ${member.multiaddr}`)
        return
      }

      if (member.memberKind !== 'acp-agent') {
        this.log(`✓ Member ${args.handle} joined #${args.channelId}`)
        return
      }

      const capsClause = member.capabilities.length > 0 ? `, capabilities: [${member.capabilities.join(', ')}]` : ''
      this.log(
        `✓ Member ${args.handle} joined #${args.channelId} (driver: ${member.driverClass}, acpVersion: ${member.acpVersion ?? '?'}${capsClause})`,
      )
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

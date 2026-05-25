import {Args, Command, Flags} from '@oclif/core'

import type {
  ChannelShowQuorumRequest,
  ChannelShowQuorumResponse,
} from '../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelClientError, withChannelClient} from '../../lib/channel-client.js'

// Phase 10 Slice 10.7 — read a persisted quorum result by dispatchId.
//
// Each successful `brv channel mention --quorum K` writes a snapshot of its
// MergedQuorum to `.brv/channel-history/<channelId>/quorum/<dispatchId>.ndjson`.
// This command surfaces the latest snapshot.
export default class ChannelShowQuorum extends Command {
  public static args = {
    channelId: Args.string({description: 'Channel handle', required: true}),
    dispatchId: Args.string({description: 'Quorum dispatch id (from a prior --quorum mention response)', required: true}),
  }
public static description = 'Read the latest persisted quorum result for a channel/dispatch pair.'
public static examples = [
    '<%= config.bin %> <%= command.id %> review-2026 quorum-mpaq1vjl-o9puzt --json',
  ]
public static flags = {
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelShowQuorum)

    try {
      await withChannelClient(async (client) => {
        const response = await client.request<ChannelShowQuorumRequest, ChannelShowQuorumResponse>(
          ChannelEvents.SHOW_QUORUM,
          {channelId: args.channelId, dispatchId: args.dispatchId},
        )

        if (flags.json) {
          this.log(JSON.stringify(response, undefined, 2))
          return
        }

        if (!response.found) {
          this.logToStderr(`No persisted quorum found for channel=${args.channelId} dispatchId=${args.dispatchId}.`)
          this.exit(1)
          return
        }

        this.log(JSON.stringify(response.snapshot, undefined, 2))
        this.log(`snapshottedAt ${response.snapshottedAt ?? 'unknown'}`)
      })
    } catch (error) {
      if (error instanceof ChannelClientError) {
        if (flags.json) {
          this.log(JSON.stringify({code: error.code, error: error.message, success: false}))
        } else {
          this.logToStderr(`[${error.code}] ${error.message}`)
        }

        this.exit(1)
      }

      throw error
    }
  }
}

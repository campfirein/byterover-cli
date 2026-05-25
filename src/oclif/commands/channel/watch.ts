import {Args, Command, Flags} from '@oclif/core'

import type {
  ChannelGetTurnRequest,
  ChannelGetTurnResponse,
  ChannelListTurnsRequest,
  ChannelListTurnsResponse,
} from '../../../shared/transport/events/channel-events.js'
import type {TurnEvent} from '../../../shared/types/channel.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelClientError, connectChannelClient} from '../../lib/channel-client.js'

export default class ChannelWatch extends Command {
  public static args = {
    channelId: Args.string({description: 'Channel handle', required: true}),
  }
public static description = 'Tail a channel: replay events since the cutoff, then subscribe to live broadcasts'
public static examples = [
    '<%= config.bin %> <%= command.id %> pi-test',
    '<%= config.bin %> <%= command.id %> pi-test --since 2026-05-11T00:00:00Z',
  ]
public static flags = {
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
    since: Flags.string({description: 'ISO timestamp; replay events whose emittedAt >= since before subscribing'}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelWatch)
    const {since} = flags
    const render = (event: TurnEvent): void => {
      if (flags.json) {
        this.log(JSON.stringify(event))
      } else {
        const handle = event.memberHandle ?? '@you'
        switch (event.kind) {
        case 'agent_message_chunk':
        case 'agent_thought_chunk': {
          this.log(`[${event.turnId}] ${handle} ${event.kind}: ${event.content}`)
        
        break;
        }

        case 'delivery_state_change': {
          this.log(`[${event.turnId}] ${handle} delivery_state_change ${event.from} → ${event.to}`)
        
        break;
        }
 
        case 'permission_request': {
          this.log(`[${event.turnId}] ${handle} permission_request id=${event.permissionRequestId}`)
        
        break;
        }

        case 'turn_state_change': {
          this.log(`[${event.turnId}] turn_state_change ${event.from} → ${event.to}`)
        
        break;
        }

        default: {
          this.log(`[${event.turnId}] ${handle} ${event.kind}`)
        }
        }
      }
    }

    const client = await connectChannelClient()
    try {
      // Step 1: list every turn in the channel.
      const turns = await client.request<ChannelListTurnsRequest, ChannelListTurnsResponse>(
        ChannelEvents.LIST_TURNS,
        {channelId: args.channelId},
      )

      // Step 2: replay events whose emittedAt >= --since (or all events when
      // --since is omitted). Record the (turnId, seq) pairs we already printed
      // so the live subscription does not double-print.
      const printed = new Set<string>()
      const cutoff = since === undefined ? undefined : Date.parse(since)
      for (const turn of turns.turns) {
        // eslint-disable-next-line no-await-in-loop
        const full = await client.request<ChannelGetTurnRequest, ChannelGetTurnResponse>(
          ChannelEvents.GET_TURN,
          {channelId: args.channelId, turnId: turn.turnId},
        )
        for (const event of full.events) {
          if (cutoff !== undefined && Date.parse(event.emittedAt) < cutoff) continue
          render(event)
          printed.add(`${event.turnId}\0${event.seq}`)
        }
      }

      // Step 3: join the broadcast room AFTER replay so we don't miss live events.
      const offTurnEvent = client.on<{channelId: string; event: TurnEvent}>(
        ChannelEvents.TURN_EVENT,
        (data) => {
          if (data.channelId !== args.channelId) return
          const key = `${data.event.turnId}\0${data.event.seq}`
          if (printed.has(key)) return
          printed.add(key)
          render(data.event)
        },
      )
      await client.subscribe(args.channelId)

      // Step 4: park forever (until SIGINT).
      await new Promise<void>((resolve) => {
        const cleanup = async (): Promise<void> => {
          offTurnEvent()
          await client.unsubscribe(args.channelId).catch(() => {})
          resolve()
        }

        process.once('SIGINT', () => {
          cleanup().catch(() => {})
        })
        process.once('SIGTERM', () => {
          cleanup().catch(() => {})
        })
      })
    } catch (error) {
      this.handleError(error, flags.json)
    } finally {
      client.disconnect()
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

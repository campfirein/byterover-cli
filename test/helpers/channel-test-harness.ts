import {TransportClient} from '@campfirein/brv-transport-client'

import type {TransportConnector} from '../../src/server/infra/transport/transport-connector.js'

import {channelsEnabled, registerDisabledStubs} from '../../src/server/infra/transport/handlers/channel-disabled-handler.js'
import {ChannelCancelHandler} from '../../src/server/infra/transport/handlers/channel/channel-cancel-handler.js'
import {ChannelCreateHandler} from '../../src/server/infra/transport/handlers/channel/channel-create-handler.js'
import {ChannelGetHandler} from '../../src/server/infra/transport/handlers/channel/channel-get-handler.js'
import {ChannelInviteHandler} from '../../src/server/infra/transport/handlers/channel/channel-invite-handler.js'
import {ChannelListHandler} from '../../src/server/infra/transport/handlers/channel/channel-list-handler.js'
import {ChannelListTurnsHandler} from '../../src/server/infra/transport/handlers/channel/channel-list-turns-handler.js'
import {ChannelMentionHandler} from '../../src/server/infra/transport/handlers/channel/channel-mention-handler.js'
import {ChannelOnboardHandler} from '../../src/server/infra/transport/handlers/channel/channel-onboard-handler.js'
import {ChannelShowHandler} from '../../src/server/infra/transport/handlers/channel/channel-show-handler.js'
import {ChannelSubscribeHandler} from '../../src/server/infra/transport/handlers/channel/channel-subscribe-handler.js'
import {SocketIOTransportServer} from '../../src/server/infra/transport/socket-io-transport-server.js'

/** Sequential port allocator so concurrent/successive harnesses never collide. */
let nextPort = 9740

/** A booted in-process channel daemon plus the seam a command connects through. */
export type ChannelHarness = {
  /** Connector to inject into a command's `channelClientOptions()` (DI seam). */
  connector: TransportConnector
  /** Port the in-process transport server is bound to. */
  port: number
  /** Disconnects clients, stops the server, and restores mutated env. */
  teardown: () => Promise<void>
}

/**
 * Boots a real {@link SocketIOTransportServer} in-process and registers the
 * channel handler surface exactly the way production does — gated through the
 * real {@link channelsEnabled} check. With `enabled` the 10 per-event handlers
 * are wired (so a `channel:*` request resolves to `CHANNEL_NOT_IMPLEMENTED`);
 * without it, {@link registerDisabledStubs} is used (resolving to
 * `CHANNEL_DISABLED`). The returned `connector` drives the actual oclif command
 * against this server with no subprocess and no daemon spawn.
 */
export async function startChannelHarness(options: {enabled: boolean; port?: number}): Promise<ChannelHarness> {
  const previousSessionLog = process.env.BRV_SESSION_LOG
  const previousChannelsFlag = process.env.BRV_CHANNELS_ENABLED
  process.env.BRV_SESSION_LOG = '/dev/null'
  process.env.BRV_CHANNELS_ENABLED = options.enabled ? '1' : '0'

  const port = options.port ?? nextPort++
  const server = new SocketIOTransportServer()
  await server.start(port)

  // Mirror feature-handlers.ts: register live handlers or disabled stubs based
  // on the real gate, so the harness exercises production registration logic.
  if (channelsEnabled()) {
    new ChannelCreateHandler(server).setup()
    new ChannelListHandler(server).setup()
    new ChannelGetHandler(server).setup()
    new ChannelInviteHandler(server).setup()
    new ChannelOnboardHandler(server).setup()
    new ChannelMentionHandler(server).setup()
    new ChannelShowHandler(server).setup()
    new ChannelListTurnsHandler(server).setup()
    new ChannelSubscribeHandler(server).setup()
    new ChannelCancelHandler(server).setup()
  } else {
    registerDisabledStubs(server)
  }

  const clients: TransportClient[] = []
  const connector: TransportConnector = async (_fromDir, projectPath) => {
    const client = new TransportClient()
    await client.connect(`http://127.0.0.1:${port}`)
    clients.push(client)
    return {client, projectRoot: projectPath}
  }

  const teardown = async (): Promise<void> => {
    await Promise.all(
      clients
        .filter((client) => client.getState() !== 'disconnected')
        .map((client) => client.disconnect().catch(() => {})),
    )

    if (server.isRunning()) {
      await server.stop()
    }

    restoreEnv('BRV_SESSION_LOG', previousSessionLog)
    restoreEnv('BRV_CHANNELS_ENABLED', previousChannelsFlag)
  }

  return {connector, port, teardown}
}

function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = previous
  }
}

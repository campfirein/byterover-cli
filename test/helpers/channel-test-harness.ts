import {TransportClient} from '@campfirein/brv-transport-client'
import {randomUUID} from 'node:crypto'
import {promises as fs} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {IChannelOrchestrator} from '../../src/server/core/interfaces/channel/i-channel-orchestrator.js'
import type {TransportConnector} from '../../src/server/infra/transport/transport-connector.js'

import {TransportChannelBroadcaster} from '../../src/server/infra/channel/channel-broadcaster.js'
import {FileChannelStore} from '../../src/server/infra/channel/channel-store.js'
import {FileDriverProfileStore} from '../../src/server/infra/channel/driver-profile-store.js'
import {AcpDriver} from '../../src/server/infra/channel/drivers/acp-driver.js'
import {DriverPool} from '../../src/server/infra/channel/drivers/driver-pool.js'
import {ChannelOnboardService} from '../../src/server/infra/channel/onboard-service.js'
import {ChannelOrchestrator} from '../../src/server/infra/channel/orchestrator.js'
import {FileTranscriptStore} from '../../src/server/infra/channel/storage/file-transcript-store.js'
import {TurnSequenceAllocator} from '../../src/server/infra/channel/turn-sequence-allocator.js'
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
  /** Temp project root every request resolves to; tests read its `.brv/channel-history`. */
  projectRoot: string
  /** Disconnects clients, stops the server, removes temp dirs, and restores mutated env. */
  teardown: () => Promise<void>
}

/**
 * Boots a real {@link SocketIOTransportServer} in-process and registers the
 * channel handler surface the way production does — gated through the real
 * {@link channelsEnabled} check, with the live orchestrator + onboard service
 * wired against a temp project root (so every request resolves there) and temp
 * profile store. Without `enabled`, {@link registerDisabledStubs} is used.
 */
export async function startChannelHarness(options: {enabled: boolean; port?: number}): Promise<ChannelHarness> {
  const previousSessionLog = process.env.BRV_SESSION_LOG
  const previousChannelsFlag = process.env.BRV_CHANNELS_ENABLED
  process.env.BRV_SESSION_LOG = '/dev/null'
  process.env.BRV_CHANNELS_ENABLED = options.enabled ? '1' : '0'

  const projectRoot = await fs.mkdtemp(join(tmpdir(), 'brv-channel-project-'))
  const dataDir = await fs.mkdtemp(join(tmpdir(), 'brv-channel-data-'))

  const port = options.port ?? nextPort++
  const server = new SocketIOTransportServer()
  await server.start(port)

  // Mirror feature-handlers.ts: register live handlers or disabled stubs based
  // on the real gate, so the harness exercises production registration logic.
  if (channelsEnabled()) {
    const driverProfileStore = new FileDriverProfileStore({dataDir})
    const driverFactory = (invocation: ConstructorParameters<typeof AcpDriver>[0]['invocation'], handle: string) =>
      new AcpDriver({handle, invocation})
    const onboardService = new ChannelOnboardService({clock: () => new Date(), driverFactory, store: driverProfileStore})

    const orchestrators = new Map<string, IChannelOrchestrator>()
    const getOrchestrator = (root: string): IChannelOrchestrator => {
      const existing = orchestrators.get(root)
      if (existing !== undefined) return existing
      const orchestrator = new ChannelOrchestrator({
        broadcaster: new TransportChannelBroadcaster(server),
        clock: () => new Date(),
        driverFactory,
        idGenerator: randomUUID,
        pool: new DriverPool(),
        profileStore: driverProfileStore,
        projectRoot: root,
        seqAllocator: new TurnSequenceAllocator(),
        store: new FileChannelStore({projectRoot: root}),
        transcriptStore: new FileTranscriptStore(),
      })
      orchestrators.set(root, orchestrator)
      return orchestrator
    }

    const resolveProjectPath = (): string => projectRoot

    new ChannelCreateHandler({getOrchestrator, resolveProjectPath, transport: server}).setup()
    new ChannelInviteHandler({getOrchestrator, resolveProjectPath, transport: server}).setup()
    new ChannelOnboardHandler({onboardService, transport: server}).setup()
    new ChannelMentionHandler({getOrchestrator, resolveProjectPath, transport: server}).setup()
    new ChannelListHandler(server).setup()
    new ChannelGetHandler(server).setup()
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

    await fs.rm(projectRoot, {force: true, recursive: true})
    await fs.rm(dataDir, {force: true, recursive: true})
    restoreEnv('BRV_SESSION_LOG', previousSessionLog)
    restoreEnv('BRV_CHANNELS_ENABLED', previousChannelsFlag)
  }

  return {connector, port, projectRoot, teardown}
}

function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = previous
  }
}

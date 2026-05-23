import {Args, Command, Flags} from '@oclif/core'
import {mkdir} from 'node:fs/promises'
import {join} from 'node:path'

import type {
  ChannelCreateRequest,
  ChannelCreateResponse,
  ChannelGetRequest,
  ChannelGetResponse,
  ChannelInviteRequest,
  ChannelInviteResponse,
} from '../../../shared/transport/events/channel-events.js'
import type {BridgeConnectDeps, BridgeConnectStepResult, StepName} from '../../lib/bridge-connect.js'

import {InstallIdentityService} from '../../../agent/core/trust/install-identity-service.js'
import {TofuStore} from '../../../agent/core/trust/tofu-store.js'
import {loadPinnedPeer, verifyPin} from '../../../agent/core/trust/verify-pin.js'
import {DEFAULT_BRIDGE_CONFIG} from '../../../server/infra/channel/bridge/bridge-config.js'
import {fetchAndPin} from '../../../server/infra/channel/bridge/identity-client.js'
import {Libp2pHost} from '../../../server/infra/channel/bridge/libp2p-host.js'
import {getGlobalDataDir} from '../../../server/utils/global-data-path.js'
import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {
  BridgeConnectInvalidMultiaddrError,
  runBridgeConnect,
} from '../../lib/bridge-connect.js'
import {ChannelClientError, withChannelClient} from '../../lib/channel-client.js'

/**
 * Phase 9.5.6 — `brv bridge connect <multiaddr>`.
 *
 * Bundles the four-step setup ceremony (pin → verify → channel new →
 * channel invite) into one idempotent command. Per codex 2026-05-23
 * sign-off: no transactional state. Each completed step is independently
 * valid; partial failures surface the steps that completed plus a
 * copy-paste-ready retry hint that omits already-done flags.
 */
export default class BridgeConnect extends Command {
  public static args = {
    multiaddr: Args.string({
      description: 'Full multiaddr with /p2p/<peer-id> suffix, e.g. /ip4/100.x/tcp/60001/p2p/12D3KooW...',
      required: true,
    }),
  }
public static description = 'Connect to a remote peer in one command: pin + (optionally) verify + (optionally) join a channel'
public static examples = [
    '<%= config.bin %> <%= command.id %> /ip4/100.68.28.21/tcp/60001/p2p/12D3KooW...',
    '<%= config.bin %> <%= command.id %> /ip4/100.68.28.21/tcp/60001/p2p/12D3KooW... --alias gcp --verify',
    '<%= config.bin %> <%= command.id %> /ip4/100.68.28.21/tcp/60001/p2p/12D3KooW... --alias gcp --verify --channel cc-chat',
  ]
public static flags = {
    alias: Flags.string({
      description: 'Display handle to use when inviting this peer to a channel (e.g. "gcp" → @gcp). Optional.',
    }),
    channel: Flags.string({
      description: 'Channel id to join. Creates the channel locally if it does not exist and invites the peer as a remote-peer member.',
    }),
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
    verify: Flags.boolean({
      default: false,
      description: 'Immediately promote the pin from auto-tofu to user-confirmed. Assumes you have eyeballed the multiaddr out-of-band (e.g. shared via Tailscale).',
    }),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(BridgeConnect)

    const aliasHandle = flags.alias === undefined
      ? undefined
      : flags.alias.startsWith('@') ? flags.alias : `@${flags.alias}`

    // Validate multiaddr suffix BEFORE the expensive libp2p host start
    // (codex r7 minor: avoid side effects on bad input). The lib will
    // re-validate inside runBridgeConnect, but doing it here lets us
    // exit fast without paying the libp2p init cost.
    if (!/\/p2p\/[1-9A-HJ-NP-Za-km-z]+$/.test(args.multiaddr)) {
      this.renderError(
        {
          code: 'BRIDGE_CONNECT_INVALID_MULTIADDR',
          message: `multiaddr ${args.multiaddr} is missing a /p2p/<peer-id> suffix — without it the verifier has no expected peer_id to check.`,
        },
        flags.json,
      )
      return
    }

    const dataDir = getGlobalDataDir()
    const installDir = join(dataDir, 'identity')
    const tofuPath = join(installDir, 'known-peers.jsonl')
    await mkdir(installDir, {mode: 0o700, recursive: true})

    const install = new InstallIdentityService({installDir})
    await install.loadOrGenerate()
    const tofu = new TofuStore({storePath: tofuPath})
    const host = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: install})
    await host.start()

    try {
      const deps = buildDeps({host, tofu})
      let result: BridgeConnectStepResult
      try {
        result = await runBridgeConnect(
          {
            alias: aliasHandle,
            channelId: flags.channel,
            multiaddr: args.multiaddr,
            verify: flags.verify,
          },
          deps,
        )
      } catch (error) {
        if (error instanceof BridgeConnectInvalidMultiaddrError) {
          this.renderError({code: error.code, message: error.message}, flags.json)
          return
        }

        throw error
      }

      this.renderResult(result, flags.json)
      if (!result.success) {
        this.exit(1)
      }
    } finally {
      await host.stop().catch(() => {})
    }
  }

  private renderError(error: {code: string; message: string}, asJson: boolean): void {
    if (asJson) {
      this.log(JSON.stringify({error, success: false}))
    } else {
      this.logToStderr(`[${error.code}] ${error.message}`)
    }

    this.exit(1)
  }

  private renderResult(result: BridgeConnectStepResult, asJson: boolean): void {
    if (asJson) {
      this.log(JSON.stringify(result, undefined, 2))
      return
    }

    if (result.success) {
      // Per-step status lines.
      this.log(`[OK pin] ${formatPinStatus(result.steps.pin)}`)
      if (result.steps.verify !== null) {
        this.log(`[OK verify] ${formatVerifyStatus(result.steps.verify)}`)
      }

      if (result.steps.channelCreate !== null) {
        this.log(`[OK channel] ${result.steps.channelCreate}`)
      }

      if (result.steps.channelInvite !== null) {
        this.log(`[OK invite] ${result.steps.channelInvite}${result.alias === undefined ? '' : ` as ${result.alias}`}`)
      }

      const tail: string[] = []
      tail.push(`\n✓ Connected to peer ${result.peerId}${result.alias === undefined ? '' : ` (${result.alias})`}`)
      if (result.channelId !== undefined) {
        tail.push(`   Channel: #${result.channelId}`)
        const mentionHandle = result.alias ?? `@${result.peerId.slice(0, 12)}...`
        tail.push(`   Ready to mention: brv channel mention ${result.channelId} "${mentionHandle} ..."`)
      }

      this.log(tail.join('\n'))
      return
    }

    // Partial failure path.
    for (const step of result.completed) {
      this.log(`[OK ${step}]`)
    }

    this.log(`[FAIL ${result.failedAt}] [${result.error.code}] ${result.error.message}`)
    this.log('')
    this.log('Already-completed steps were persisted. To retry just the remaining work, run:')
    this.log('')
    this.log(`  ${result.retryHint}`)
  }
}

interface BuildDepsArgs {
  readonly host: Libp2pHost
  readonly tofu: TofuStore
}

async function channelExists(channelId: string): Promise<boolean> {
  try {
    await withChannelClient(async (client) =>
      client.request<ChannelGetRequest, ChannelGetResponse>(ChannelEvents.GET, {channelId}),
    )
    return true
  } catch (error) {
    if (error instanceof ChannelClientError && error.code === 'CHANNEL_NOT_FOUND') return false
    throw error
  }
}

async function channelHasMember(channelId: string, peerId: string): Promise<boolean> {
  try {
    const response = await withChannelClient(async (client) =>
      client.request<ChannelGetRequest, ChannelGetResponse>(ChannelEvents.GET, {channelId}),
    )
    const {members} = response.channel
    // Remote-peer members carry peerId on their record; local-acp members don't.
    return members.some((m) => 'peerId' in m && m.peerId === peerId)
  } catch (error) {
    if (error instanceof ChannelClientError && error.code === 'CHANNEL_NOT_FOUND') return false
    throw error
  }
}

function buildDeps(args: BuildDepsArgs): BridgeConnectDeps {
  const {host, tofu} = args

  return {
    async channelCreate(channelId) {
      const exists = await channelExists(channelId)
      if (exists) return {status: 'already-exists'}
      await withChannelClient(async (client) =>
        client.request<ChannelCreateRequest, ChannelCreateResponse>(ChannelEvents.CREATE, {channelId}),
      )
      return {status: 'created'}
    },
    channelExists,
    channelHasMember,
    async channelInvite(inviteArgs) {
      const has = await channelHasMember(inviteArgs.channelId, inviteArgs.peerId)
      if (has) return {status: 'already-member'}
      const handle = inviteArgs.alias ?? `@${inviteArgs.peerId.slice(0, 12)}`
      await withChannelClient(async (client) =>
        client.request<ChannelInviteRequest, ChannelInviteResponse>(ChannelEvents.INVITE, {
          channelId: inviteArgs.channelId,
          handle,
          remotePeer: {
            multiaddr: inviteArgs.multiaddr,
            peerId: inviteArgs.peerId,
          },
        }),
      )
      return {status: 'added'}
    },
    async pin(multiaddr, peerId) {
      const existing = await tofu.get(peerId)
      const pinned = await fetchAndPin({
        expectedPeerId: peerId,
        host,
        multiaddr,
        tofuStore: tofu,
      })
      return {
        peerId: pinned.peer_id,
        pinState: pinned.pin_state,
        resolvedMultiaddr: multiaddr,
        status: existing === undefined ? 'added' : 'already-pinned',
      }
    },
    async verify(peerId) {
      const existing = await loadPinnedPeer({peerId, tofu})
      if (existing.pin_state === 'user-confirmed') return {status: 'already-user-confirmed'}
      if (existing.pin_state === 'ca-bound') return {status: 'ca-bound'}
      await verifyPin({peerId, tofu})
      return {status: 'user-confirmed'}
    },
  }
}

function formatPinStatus(s: 'added' | 'already-pinned'): string {
  return s === 'added' ? 'pinned (new)' : 'already pinned'
}

function formatVerifyStatus(s: string): string {
  if (s === 'user-confirmed') return 'promoted to user-confirmed'
  if (s === 'already-user-confirmed') return 'already user-confirmed'
  if (s === 'ca-bound') return 'ca-bound (no change)'
  return s
}

// Suppress unused-export warnings for the StepName type — it's part of
// the lib's public API surface used by tests + the lib itself, not by
// this command, but importing it here keeps the contract visible.
type _UnusedSurface = StepName // eslint-disable-line @typescript-eslint/no-unused-vars

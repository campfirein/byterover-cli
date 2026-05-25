/* eslint-disable camelcase */
// `turn_id` / `delivery_id` / `channel_id` mirror IMPLEMENTATION_PHASE_9
// §5.1 envelope shape and are intentionally snake_case on the wire.

import {Args, Command, Flags} from '@oclif/core'
import {randomBytes} from 'node:crypto'
import {mkdir} from 'node:fs/promises'
import {join} from 'node:path'

import {InstallIdentityService} from '../../../agent/core/trust/install-identity-service.js'
import {PeerTreeIdentityService} from '../../../agent/core/trust/peer-tree-identity-service.js'
import {DEFAULT_BRIDGE_CONFIG} from '../../../server/infra/channel/bridge/bridge-config.js'
import {Libp2pHost} from '../../../server/infra/channel/bridge/libp2p-host.js'
import {l2PubKeyFromBase64, sendParleyQuery, type SendParleyQueryResult} from '../../../server/infra/channel/bridge/parley-client.js'
import {getGlobalDataDir} from '../../../server/utils/global-data-path.js'

/**
 * §9.5.8 Blocker 2 — Format a successful parley result as human-readable
 * text lines. Exported for unit testing.
 *
 * Returns an array of lines (without trailing newlines). The caller logs
 * them one by one. Includes an operator-visible integrity warning when the
 * result has integrityDegraded=true or terminalMissing=true so operators
 * know the transcript_seal guarantee was not met.
 */
export function formatPingResult(result: Extract<SendParleyQueryResult, {ok: true}>): string[] {
  const lines: string[] = [`endedState: ${result.endedState}`]

  // §9.5.8 Blocker 2 — integrity-degraded warning. The seal is the
  // cryptographic binding; when it's missing, operators must be informed.
  if (result.integrityDegraded) {
    lines.push(
      '',
      `⚠ integrity-degraded response: sealOrigin=${result.sealOrigin}, terminalMissing=${String(result.terminalMissing === true)}.`,
      '   Work transported under authenticated session but no transcript_seal received.',
      '   Operator should verify completion via the responder side.',
    )
  }

  lines.push('', result.content)
  return lines
}

/**
 * Phase 9 / Slice 9.3-prelude — `brv bridge ping <multiaddr> <prompt>`.
 *
 * Open a `/brv/parley/query/v1` stream to a remote peer, send a signed
 * `ParleyQueryEnvelope` carrying `<prompt>` as a single text content
 * block, read response frames, verify the transcript_seal, and print
 * Bob's echoed reply.
 *
 * The remote's L2 public key MUST be supplied via `--l2-pub-key` —
 * slice 9.3 doesn't yet have an in-band L2 cert discovery path, so the
 * operator copies the base64 from `brv bridge listen`'s startup banner.
 * Slice 9.4's `RemoteMemberDriver` will derive the L2 key from a real
 * cert resolver instead of taking it as a flag.
 */
export default class BridgePing extends Command {
  public static args = {
    multiaddr: Args.string({
      description: 'Full multiaddr with /p2p/<peer-id> suffix of the listener',
      required: true,
    }),
    prompt: Args.string({
      description: 'Prompt text Bob should echo back',
      required: true,
    }),
  }
public static description = 'Send a Parley query to a remote peer and print the echoed response'
public static examples = [
    'BRV_DATA_DIR=/tmp/brv-B <%= config.bin %> <%= command.id %> /ip4/127.0.0.1/tcp/4001/p2p/12D3KooWAlice "hello bob" --l2-pub-key <base64-from-listen-banner>',
  ]
public static flags = {
    'channel-id': Flags.string({
      default: 'bridge-ping',
      description: 'Channel id (free-form for the prelude CLI — no real channel meta is touched)',
    }),
    format: Flags.string({
      default: 'text',
      description: 'Output format',
      options: ['text', 'json'],
    }),
    'l2-pub-key': Flags.string({
      description:
        'Base64 of the remote peer\'s L2 tree pubkey (from `brv bridge listen` banner). ' +
        'This is an OUT-OF-BAND trust step for slice 9.3: response-frame integrity is ' +
        'only as good as this value. Passing the wrong key causes verification failure; ' +
        'a man-in-the-middle who can swap it can fool you about the responder\'s identity. ' +
        'Slice 9.4 replaces this with in-band L2 cert discovery.',
      required: true,
    }),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(BridgePing)

    const dataDir = getGlobalDataDir()
    const installDir = join(dataDir, 'identity')
    await mkdir(installDir, {mode: 0o700, recursive: true})

    const install = new InstallIdentityService({installDir})
    await install.loadOrGenerate()
    const l2 = new PeerTreeIdentityService({install})
    await l2.loadOrGenerate()

    const remoteL2PubKey = l2PubKeyFromBase64(flags['l2-pub-key'])

    // Ephemeral dialer host.
    const host = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: install})
    await host.start()

    // Append entropy so two pings issued in the same millisecond don't
    // collide on turn_id (kimi round-1 NIT).
    const turn_id = `cli-${Date.now()}-${randomBytes(2).toString('hex')}`
    const delivery_id = `cli-${randomBytes(4).toString('hex')}`

    try {
      const result = await sendParleyQuery({
        channel_id: flags['channel-id'],
        delivery_id,
        host,
        install,
        l2Identity: l2,
        multiaddr: args.multiaddr,
        prompt: [{text: args.prompt, type: 'text'}],
        remoteL2PubKey,
        turn_id,
      })

      if (flags.format === 'json') {
        this.log(JSON.stringify(result, null, 2))
      } else if (result.ok) {
        for (const line of formatPingResult(result)) {
          this.log(line)
        }
      } else {
        this.error(`server rejected: ${result.code} — ${result.message}`, {exit: 1})
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (flags.format === 'json') {
        this.log(JSON.stringify({error: msg, ok: false}))
      } else {
        this.error(msg, {exit: 1})
      }
    } finally {
      // Swallow stop errors so a stuck libp2p teardown doesn't mask
      // the real failure (kimi round-1 LOW).
      await host.stop().catch(() => {})
    }
  }
}

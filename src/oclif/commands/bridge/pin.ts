import {Args, Command, Flags} from '@oclif/core'
import {mkdir} from 'node:fs/promises'
import {join} from 'node:path'

import {InstallIdentityService} from '../../../agent/core/trust/install-identity-service.js'
import {TofuStore} from '../../../agent/core/trust/tofu-store.js'
import {verifyPin, VerifyPinError} from '../../../agent/core/trust/verify-pin.js'
import {DEFAULT_BRIDGE_CONFIG} from '../../../server/infra/channel/bridge/bridge-config.js'
import {fetchAndPin} from '../../../server/infra/channel/bridge/identity-client.js'
import {Libp2pHost} from '../../../server/infra/channel/bridge/libp2p-host.js'
import {getGlobalDataDir} from '../../../server/utils/global-data-path.js'

/**
 * Phase 9 / Slice 9.3-prelude — `brv bridge pin <multiaddr>`.
 *
 * Dial a remote peer via `/brv/identity/cert/v1`, fetch their
 * `InstallCertificate`, run the AMENDMENT_TOFU §A3.2 verifier guards,
 * and TOFU-pin the result to the local `known-peers.jsonl`.
 *
 * The multiaddr MUST carry a `/p2p/<peer-id>` suffix (libp2p's standard
 * form) — the suffix is the expected peer_id for the verifier's
 * guard 4 (subject_id match). Operators get the multiaddr from
 * `brv bridge listen`'s startup banner.
 */
export default class BridgePin extends Command {
  public static args = {
    multiaddr: Args.string({
      description: 'Full multiaddr with /p2p/<peer-id> suffix, e.g. /ip4/127.0.0.1/tcp/4001/p2p/12D3KooWAAA',
      required: true,
    }),
  }
public static description = 'TOFU-pin a remote peer by dialing /brv/identity/cert/v1'
public static examples = [
    '<%= config.bin %> <%= command.id %> /ip4/127.0.0.1/tcp/4001/p2p/12D3KooWAlice',
    'BRV_DATA_DIR=/tmp/brv-B <%= config.bin %> <%= command.id %> /ip4/127.0.0.1/tcp/4001/p2p/12D3KooWAlice',
  ]
public static flags = {
    format: Flags.string({
      default: 'text',
      description: 'Output format',
      options: ['text', 'json'],
    }),
    verify: Flags.boolean({
      default: false,
      description: 'After pinning, immediately promote to user-confirmed (assumes you have eyeballed the multiaddr out-of-band). Eliminates the separate `brv bridge verify` step.',
    }),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(BridgePin)

    const peerId = extractPeerIdFromMultiaddr(args.multiaddr)
    if (!peerId) {
      this.error(
        `multiaddr ${args.multiaddr} is missing a /p2p/<peer-id> suffix — without it the verifier has no expected peer_id to check.`,
        {exit: 1},
      )
    }

    const dataDir = getGlobalDataDir()
    const installDir = join(dataDir, 'identity')
    const tofuPath = join(dataDir, 'identity', 'known-peers.jsonl')
    await mkdir(installDir, {mode: 0o700, recursive: true})

    const install = new InstallIdentityService({installDir})
    await install.loadOrGenerate()
    const tofu = new TofuStore({storePath: tofuPath})

    // Ephemeral dialer — no listen address, just outbound.
    const host = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: install})
    await host.start()

    try {
      let pinned = await fetchAndPin({
        expectedPeerId: peerId,
        host,
        multiaddr: args.multiaddr,
        tofuStore: tofu,
      })

      // Phase 9.5 §3.2 — `--verify` promotes the pin to user-confirmed in one
      // shot, eliminating the separate `brv bridge verify` step. Surface the
      // verify error code separately so callers can distinguish pin failure from
      // verify failure.
      let verified = false
      if (flags.verify) {
        try {
          pinned = await verifyPin({peerId: pinned.peer_id, tofu})
          verified = true
        } catch (error) {
          const code = error instanceof VerifyPinError ? error.code : 'BRIDGE_VERIFY_FAILED'
          const msg = error instanceof Error ? error.message : String(error)
          if (flags.format === 'json') {
            this.log(JSON.stringify({code, error: msg, ok: false}))
          } else {
            this.error(`${code}: ${msg}`, {exit: 1})
          }

          return
        }
      }

      if (flags.format === 'json') {
        const out: Record<string, unknown> = {data: pinned, ok: true}
        if (flags.verify) out.verified = verified
        this.log(JSON.stringify(out))
      } else {
        this.log('pinned:')
        this.log(`  peer_id:                    ${pinned.peer_id}`)
        this.log(`  install_cert_fingerprint:   ${pinned.install_cert_fingerprint}`)
        this.log(`  pin_state:                  ${pinned.pin_state}`)
        this.log(`  first_seen_at:              ${pinned.first_seen_at}`)
        this.log(`  last_seen_at:               ${pinned.last_seen_at}`)
        if (pinned.display_handle) {
          this.log(`  display_handle:             ${pinned.display_handle}`)
        }

        if (verified) {
          this.log('verified: pin_state promoted to user-confirmed')
        }
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

/**
 * Extract `<peer-id>` from the trailing `/p2p/<peer-id>` segment of a
 * multiaddr. Returns `undefined` if the suffix is missing.
 */
function extractPeerIdFromMultiaddr(multiaddr: string): string | undefined {
  // Restrict to the base58btc alphabet libp2p uses for PeerIDs
  // (kimi round-1 LOW — defense-in-depth before the verifier's
  // canonical guard 4 catches a wrong peer_id).
  const match = multiaddr.match(/\/p2p\/([1-9A-HJ-NP-Za-km-z]+)$/)
  return match ? match[1] : undefined
}

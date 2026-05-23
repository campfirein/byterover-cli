import {Command, Flags} from '@oclif/core'

import {classifyMultiaddr} from '../../../server/utils/multiaddr-classify.js'
import {BridgeEvents, type BridgeWhoamiResponse} from '../../../shared/transport/events/bridge-events.js'
import {formatConnectionError, withDaemonRetry} from '../../lib/daemon-client.js'
import {writeJsonResponse} from '../../lib/json-response.js'

/**
 * Phase 9 / Slice 9.4b — `brv bridge whoami`.
 *
 * Print the running daemon's libp2p bridge identity:
 *   - peer_id      — L1 install peer_id (base58btc)
 *   - multiaddrs   — current libp2p listen addresses with /p2p/<id> suffix
 *   - l2_pub_key   — base64 of the L2 tree pubkey (paste into
 *                    `brv channel invite --l2-pub-key`)
 *   - tree_id      — UUIDv7 of the L2 peer-tree cert
 *
 * Forces the daemon's bridge host to bring itself up if it hasn't yet
 * (lazy init). Operators use this to share their identity with a
 * remote install that wants to add them as a `remote-peer` channel
 * member, without running a separate `brv bridge listen` process.
 */
export default class BridgeWhoami extends Command {
  public static description = 'Print this install\'s libp2p bridge identity (peer_id, multiaddrs, L2 pubkey)'
public static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --format json',
  ]
public static flags = {
    format: Flags.string({
      default: 'text',
      description: 'Output format',
      options: ['text', 'json'],
    }),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(BridgeWhoami)

    try {
      const response = await withDaemonRetry<BridgeWhoamiResponse>(async (client) => client.requestWithAck<BridgeWhoamiResponse>(BridgeEvents.WHOAMI), {projectPath: process.cwd()})

      // Phase 9.5 §3.4 — annotate multiaddrs with interface kind.
      const annotated = response.multiaddrs.map((addr) => {
        const {iface, kind} = classifyMultiaddr(addr)
        return {addr, iface, kind}
      })

      if (flags.format === 'json') {
        writeJsonResponse({
          command: 'bridge:whoami',
          data: {
            ...response,
            // Backwards-compatible: keep bare multiaddrs array, add annotated array.
            multiaddrsAnnotated: annotated,
          },
          success: true,
        })
        return
      }

      this.log('brv bridge identity:')
      this.log('')
      this.log(`  peer_id:     ${response.peerId}`)
      this.log('  multiaddrs:')
      for (const {addr, iface, kind} of annotated) {
        const ifacePart = iface === undefined ? '' : `, ${iface}`
        const annotation = kind === 'unknown' ? '' : `  (${kind}${ifacePart})`
        const recommendation = kind === 'tailscale' ? '  ← recommended for cross-machine' : ''
        this.log(`    ${addr}${annotation}${recommendation}`)
      }

      this.log(`  l2_pub_key:  ${response.l2PubKey}`)
      this.log(`  tree_id:     ${response.treeId}`)
      this.log('')
      this.log('Share peer_id + multiaddr with a remote install; L2 cert is auto-discovered:')
      this.log(`  brv channel invite <channel> @<handle> \\`)
      this.log(`    --peer ${response.peerId} \\`)
      if (response.multiaddrs.length > 0) {
        this.log(`    --multiaddr ${response.multiaddrs[0]}`)
      }

      this.log('')
      this.log(`  (Override in-band L2 discovery with --l2-pub-key ${response.l2PubKey})`)
    } catch (error) {
      if (flags.format === 'json') {
        writeJsonResponse({command: 'bridge:whoami', data: {error: formatConnectionError(error)}, success: false})
      } else {
        this.log(formatConnectionError(error))
        this.exit(1)
      }
    }
  }
}

/* eslint-disable camelcase */
// `BridgeConfig.listen_addrs` mirrors the on-disk YAML/JSON snake_case
// shape; intentional.

import {Command, Flags} from '@oclif/core'
import {mkdir} from 'node:fs/promises'
import {join} from 'node:path'

import {InstallIdentityService} from '../../../agent/core/trust/install-identity-service.js'
import {PeerTreeIdentityService} from '../../../agent/core/trust/peer-tree-identity-service.js'
import {TofuStore} from '../../../agent/core/trust/tofu-store.js'
import {type BridgeConfig, DEFAULT_BRIDGE_CONFIG} from '../../../server/infra/channel/bridge/bridge-config.js'
import {registerIdentityServer} from '../../../server/infra/channel/bridge/identity-server.js'
import {Libp2pHost} from '../../../server/infra/channel/bridge/libp2p-host.js'
import {registerParleyServer} from '../../../server/infra/channel/bridge/parley-server.js'
import {getGlobalDataDir} from '../../../server/utils/global-data-path.js'

/**
 * Phase 9 / Slice 9.3-prelude — `brv bridge listen`.
 *
 * Standalone, long-running listener that bootstraps a libp2p host
 * from the current install's L1 identity, registers the identity
 * server (`/brv/identity/cert/v1`) and the parley query server
 * (`/brv/parley/query/v1`), and prints the connection details for an
 * out-of-band copy to a dialer (a second brv install).
 *
 * NOT daemon-integrated — runs as a standalone process so testers can
 * spin up two brv installs side-by-side via `BRV_DATA_DIR=...` without
 * fighting daemon port collisions. Slice 9.4's `RemoteMemberDriver`
 * will fold this into the daemon's normal startup path.
 *
 * Stays alive until SIGINT / SIGTERM.
 */
export default class BridgeListen extends Command {
  public static description =
    'Start a libp2p bridge listener exposing /brv/identity/cert/v1 and /brv/parley/query/v1 over the current install identity'
public static examples = [
    '<%= config.bin %> <%= command.id %> --port 4001',
    'BRV_DATA_DIR=/tmp/brv-A <%= config.bin %> <%= command.id %> --port 4001',
    '<%= config.bin %> <%= command.id %> --port 4001 --tofu-policy auto',
  ]
public static flags = {
    'accept-modes': Flags.string({
      default: 'peer-tree',
      description: 'Comma-separated tree-cert kinds Bob accepts inbound',
    }),
    listen: Flags.string({
      default: '/ip4/127.0.0.1/tcp/0',
      description: 'Override the libp2p listen multiaddr; "0" means pick any free port',
    }),
    port: Flags.integer({
      description: 'TCP port to bind (default: random); shortcut for --listen /ip4/0.0.0.0/tcp/<port>',
    }),
    'tofu-policy': Flags.string({
      default: 'auto',
      description: 'TOFU policy for inbound parley queries from unknown peers',
      options: ['auto', 'deny'],
    }),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(BridgeListen)

    const dataDir = getGlobalDataDir()
    const installDir = join(dataDir, 'identity')
    const tofuPath = join(dataDir, 'identity', 'known-peers.jsonl')
    await mkdir(installDir, {mode: 0o700, recursive: true})

    const install = new InstallIdentityService({installDir})
    const installIdentity = await install.loadOrGenerate()
    const l2 = new PeerTreeIdentityService({install})
    const l2Identity = await l2.loadOrGenerate()
    const tofu = new TofuStore({storePath: tofuPath})

    // Apply --port to the --listen multiaddr WITHOUT silently widening the
    // bind address (kimi round-1 HIGH — `/ip4/0.0.0.0` exposes the
    // listener to the LAN, which the operator did not opt into). We
    // splice the port in-place; the host (default 127.0.0.1) is
    // preserved. Use `--listen /ip4/0.0.0.0/tcp/<p>` explicitly to bind
    // all interfaces.
    const listenAddr = flags.port === undefined
      ? flags.listen
      : flags.listen.replace(/\/tcp\/\d+/, `/tcp/${flags.port}`)
    const config: BridgeConfig = {
      ...DEFAULT_BRIDGE_CONFIG,
      listen_addrs: [listenAddr],
    }

    const host = new Libp2pHost({config, identity: install})
    await host.start()

    await registerIdentityServer({host, identity: install})
    const rawAcceptModes = flags['accept-modes'].split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    const acceptModes = rawAcceptModes
      .filter((s): s is 'ca-issued-tree' | 'peer-tree' => s === 'peer-tree' || s === 'ca-issued-tree')
    if (acceptModes.length !== rawAcceptModes.length) {
      // Surface invalid tokens loudly instead of silently dropping them
      // (kimi round-1 MEDIUM).
      const dropped = rawAcceptModes.filter((s) => !acceptModes.includes(s as 'ca-issued-tree' | 'peer-tree'))
      this.error(
        `--accept-modes: unknown value(s) ${JSON.stringify(dropped)}; expected comma-separated from {peer-tree, ca-issued-tree}`,
        {exit: 2},
      )
    }

    await registerParleyServer({
      acceptModes,
      host,
      l2Identity: l2,
      tofuPolicy: flags['tofu-policy'] as 'auto' | 'deny',
      tofuStore: tofu,
    })

    this.log('brv bridge listener ready')
    this.log('')
    this.log(`  peer_id:     ${installIdentity.peerId}`)
    this.log('  multiaddrs:')
    for (const ma of host.getMultiaddrs()) {
      this.log(`    ${ma}`)
    }

    this.log(`  l2_pub_key:  ${l2Identity.cert.public_key.key}`)
    this.log(`  tree_id:     ${l2Identity.cert.subject_id}`)
    this.log('')
    this.log('  data_dir:       ' + dataDir)
    this.log('  accept_modes:   ' + acceptModes.join(','))
    this.log('  tofu_policy:    ' + flags['tofu-policy'])
    this.log('')
    this.log('Press Ctrl-C to stop.')

    let stopping = false
    const stop = async () => {
      if (stopping) return
      stopping = true
      this.log('\nshutting down…')
      // Race a hard timeout against libp2p's stop — TCP teardown can
      // hang on a stuck connection (kimi round-1 MEDIUM). We swallow
      // errors here; exit unconditionally.
      const timeout = new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 5000)
      })
      await Promise.race([host.stop().catch(() => {}), timeout])
      this.exit(0)
    }

    // process.on, not once — the `stopping` guard handles re-entry; a
    // rapid double-SIGINT shouldn't be allowed to fall through to
    // Node's default handler (kimi round-1 LOW).
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    await new Promise(() => { /* run forever — SIGINT/SIGTERM exits the process */ })
  }
}

import {confirm} from '@inquirer/prompts'
import {Args, Command, Errors, Flags} from '@oclif/core'
import {join} from 'node:path'

import {isValidPeerIdString} from '../../../agent/core/trust/peer-id.js'
import {TofuStore} from '../../../agent/core/trust/tofu-store.js'
import {loadPinnedPeer, verifyPin, VerifyPinError} from '../../../agent/core/trust/verify-pin.js'
import {getGlobalDataDir} from '../../../server/utils/global-data-path.js'

/**
 * Phase 9 / Slice 9.4g — `brv bridge verify <peer-id>`.
 *
 * Promote an already-pinned peer from `auto-tofu` to `user-confirmed`
 * so the default `pinned-only` auto-provision policy (spec §7.3)
 * accepts inbound parley queries from that peer. Run this AFTER
 * `brv bridge pin <multiaddr>` once you have eyeballed the fingerprint
 * (compared out-of-band with the remote operator).
 *
 * Idempotent: re-running on a `user-confirmed` or `ca-bound` peer is
 * a no-op success that prints the current pin state.
 *
 * Namespace note (kimi round-1 NIT-2): the spec mentions `brv trust
 * verify` in passing, but this slice lands it under the existing
 * `brv bridge` namespace alongside `pin`/`ping`/`whoami`/`listen`
 * for discoverability — operators looking for trust verbs find them
 * next to dial verbs. A future re-namespace to `brv trust *` is
 * deferred.
 */
export default class BridgeVerify extends Command {
  public static args = {
    'peer-id': Args.string({
      description: 'libp2p peer_id of the previously-pinned peer (12D3Koo… base58btc form)',
      required: true,
    }),
  }
public static description = 'Promote a pinned peer from auto-tofu to user-confirmed (after eyeballing the fingerprint)'
public static examples = [
    '<%= config.bin %> <%= command.id %> 12D3KooWAlice…',
    '<%= config.bin %> <%= command.id %> 12D3KooWAlice… --yes',
    '<%= config.bin %> <%= command.id %> 12D3KooWAlice… --format json --yes',
  ]
public static flags = {
    format: Flags.string({
      default: 'text',
      description: 'Output format',
      options: ['text', 'json'],
    }),
    yes: Flags.boolean({
      char: 'y',
      default: false,
      description: 'Skip the interactive fingerprint-confirmation prompt (for scripting)',
    }),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(BridgeVerify)
    const peerId = args['peer-id']

    // kimi round-1 LOW-4 — validate peer_id format upfront so an
    // operator typo doesn't get a misleading PEER_NOT_PINNED error
    // when the real issue is "this string isn't even a peer_id."
    if (!isValidPeerIdString(peerId)) {
      const msg = `invalid peer_id format: "${peerId}" (expected libp2p base58btc form like 12D3KooW…)`
      if (flags.format === 'json') {
        this.log(JSON.stringify({code: 'INVALID_PEER_ID', error: msg, ok: false}))
        this.exit(1)
      }

      this.error(msg, {exit: 1})
    }

    const tofuPath = join(getGlobalDataDir(), 'identity', 'known-peers.jsonl')
    const tofu = new TofuStore({storePath: tofuPath})

    try {
      // kimi round-1 MED-1 — show the operator the fingerprint they
      // are about to elevate trust on, BEFORE writing. `--yes` skips
      // the prompt for scripts; the prompt itself is skipped on
      // non-TTY stdin (e.g. piped input) so CI doesn't hang.
      const existing = await loadPinnedPeer({peerId, tofu})

      if (existing.pin_state === 'user-confirmed' || existing.pin_state === 'ca-bound') {
        // Idempotent path — no need to prompt for confirmation.
        this.renderResult(existing, flags.format)
        return
      }

      if (!flags.yes && process.stdin.isTTY === true) {
        this.log(`About to promote peer ${peerId} from auto-tofu → user-confirmed.`)
        this.log(`  install_cert_fingerprint: ${existing.install_cert_fingerprint}`)
        if (existing.display_handle !== undefined) {
          this.log(`  display_handle:           ${existing.display_handle}`)
        }

        this.log('Compare this fingerprint with the remote operator out-of-band BEFORE confirming.')
        const ok = await confirm({
          default: false,
          message: 'Promote this peer to user-confirmed?',
        })
        if (!ok) {
          this.log('Aborted.')
          this.exit(1)
        }
      }

      const peer = await verifyPin({peerId, tofu})
      this.renderResult(peer, flags.format)
    } catch (error) {
      // kimi round-2 LOW — `this.exit(1)` inside the try (e.g. the
      // prompt-decline branch) throws an `ExitError`; re-throw it so
      // the oclif harness honours its embedded exit code instead of
      // re-projecting it as a generic `BRIDGE_VERIFY_FAILED` here.
      if (error instanceof Errors.ExitError) throw error
      const msg = error instanceof Error ? error.message : String(error)
      const code = error instanceof VerifyPinError ? error.code : 'BRIDGE_VERIFY_FAILED'
      if (flags.format === 'json') {
        this.log(JSON.stringify({code, error: msg, ok: false}))
        // kimi round-1 MED-2 — non-zero exit so CI/script callers can
        // detect failure programmatically. `this.exit(1)` throws an
        // oclif ExitError which short-circuits the harness; setting
        // `process.exitCode` would be reset by oclif on success-path
        // return.
        this.exit(1)
      }

      this.error(msg, {exit: 1})
    }
  }

  private renderResult(peer: {display_handle?: string; install_cert_fingerprint: string; peer_id: string; pin_state: string}, format: string): void {
    if (format === 'json') {
      this.log(JSON.stringify({data: peer, ok: true}))
      return
    }

    this.log('verified:')
    this.log(`  peer_id:                    ${peer.peer_id}`)
    this.log(`  install_cert_fingerprint:   ${peer.install_cert_fingerprint}`)
    this.log(`  pin_state:                  ${peer.pin_state}`)
    if (peer.display_handle !== undefined) {
      this.log(`  display_handle:             ${peer.display_handle}`)
    }

    // kimi round-1 LOW-1 — be explicit about the ca-bound no-op so
    // the operator doesn't believe `verify` caused that pin state.
    if (peer.pin_state === 'ca-bound') {
      this.log('\nNote: peer was already ca-bound (CA-corroborated). No change applied.')
    } else {
      this.log(
        '\nThis peer can now mention this install on channels with the default `pinned-only`\n' +
          'auto-provision policy (spec §7.3).',
      )
    }
  }
}

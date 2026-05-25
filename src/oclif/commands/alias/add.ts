import {Args, Command, Errors, Flags} from '@oclif/core'
import {join} from 'node:path'

import {AliasStore} from '../../../agent/core/trust/alias-store.js'
import {getGlobalDataDir} from '../../../server/utils/global-data-path.js'

/**
 * Phase 9 / Slice 9.5 — `brv alias add <name> <peer-id>`.
 *
 * Map a short human-friendly name to a libp2p peer_id so
 * `brv channel mention "@<name>"` can resolve locally instead of
 * forcing the operator to paste 46-char peer_id strings.
 *
 * Aliases live in `<dataDir>/identity/aliases.json` (mode 0600).
 */
export default class AliasAdd extends Command {
  public static args = {
    name: Args.string({description: 'Short alias (e.g. `alice`)', required: true}),
    'peer-id': Args.string({description: 'Full libp2p peer_id (12D3Koo…)', required: true}),
  }
public static description = 'Map a local short name to a remote peer_id for `brv channel mention @<name>` resolution'
public static examples = [
    '<%= config.bin %> <%= command.id %> alice 12D3KooWAlice…',
    '<%= config.bin %> <%= command.id %> alice 12D3KooWAlice… --format json',
  ]
public static flags = {
    format: Flags.string({default: 'text', description: 'Output format', options: ['text', 'json']}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(AliasAdd)
    const aliasName = args.name
    const peerId = args['peer-id']

    const store = new AliasStore({
      storePath: join(getGlobalDataDir(), 'identity', 'aliases.json'),
    })

    try {
      await store.set(aliasName, peerId)
      if (flags.format === 'json') {
        this.log(JSON.stringify({alias: aliasName.trim(), ok: true, peerId}))
        return
      }

      this.log(`alias "${aliasName.trim()}" → ${peerId}`)
    } catch (error) {
      if (error instanceof Errors.ExitError) throw error
      const msg = error instanceof Error ? error.message : String(error)
      if (flags.format === 'json') {
        this.log(JSON.stringify({error: msg, ok: false}))
        this.exit(1)
      }

      this.error(msg, {exit: 1})
    }
  }
}

import {Args, Command, Flags} from '@oclif/core'
import {join} from 'node:path'

import {AliasStore} from '../../../agent/core/trust/alias-store.js'
import {getGlobalDataDir} from '../../../server/utils/global-data-path.js'

/**
 * Phase 9 / Slice 9.5 — `brv alias remove <name>`.
 *
 * Idempotent: removing an alias that does not exist is a no-op
 * success. We surface the post-removal state so scripts can detect
 * whether the operation was a no-op vs an actual delete.
 */
export default class AliasRemove extends Command {
  public static args = {
    name: Args.string({description: 'Alias to remove', required: true}),
  }
public static description = 'Remove a local alias by name (idempotent)'
public static examples = [
    '<%= config.bin %> <%= command.id %> alice',
    '<%= config.bin %> <%= command.id %> alice --format json',
  ]
public static flags = {
    format: Flags.string({default: 'text', description: 'Output format', options: ['text', 'json']}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(AliasRemove)
    const aliasName = args.name.trim()

    const store = new AliasStore({
      storePath: join(getGlobalDataDir(), 'identity', 'aliases.json'),
    })

    const existed = (await store.get(aliasName)) !== undefined
    await store.remove(aliasName)

    if (flags.format === 'json') {
      this.log(JSON.stringify({alias: aliasName, existed, ok: true}))
      return
    }

    this.log(existed ? `removed alias "${aliasName}"` : `no alias "${aliasName}" (no-op)`)
  }
}

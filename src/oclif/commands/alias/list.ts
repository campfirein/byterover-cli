import {Command, Flags} from '@oclif/core'
import {join} from 'node:path'

import {AliasStore} from '../../../agent/core/trust/alias-store.js'
import {getGlobalDataDir} from '../../../server/utils/global-data-path.js'

/**
 * Phase 9 / Slice 9.5 — `brv alias list`.
 *
 * Print every alias → peer_id mapping in `<dataDir>/identity/aliases.json`.
 * Empty list when no aliases have been set.
 */
export default class AliasList extends Command {
public static description = 'List every local alias → peer_id mapping'
public static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --format json',
  ]
public static flags = {
    format: Flags.string({default: 'text', description: 'Output format', options: ['text', 'json']}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(AliasList)

    const store = new AliasStore({
      storePath: join(getGlobalDataDir(), 'identity', 'aliases.json'),
    })

    const entries = await store.list()
    if (flags.format === 'json') {
      this.log(JSON.stringify({entries, ok: true}))
      return
    }

    if (entries.length === 0) {
      this.log('No aliases set. Add one with `brv alias add <name> <peer-id>`.')
      return
    }

    // Stable-sorted column widths so the output diffs cleanly.
    const aliasColWidth = Math.max(...entries.map((e) => e.alias.length), 8)
    for (const e of entries) {
      this.log(`${e.alias.padEnd(aliasColWidth)}  ${e.peerId}`)
    }
  }
}

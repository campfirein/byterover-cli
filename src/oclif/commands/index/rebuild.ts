import {Command, Flags} from '@oclif/core'
import {basename, join} from 'node:path'

import {BRV_DIR, CONTEXT_TREE_DIR} from '../../../server/constants.js'
import {generateContextTreeIndex} from '../../../server/infra/context-tree/index-generator.js'
import {resolveProjectRoot} from '../../lib/curate-session.js'
import {writeJsonResponse} from '../../lib/json-response.js'

/**
 * `brv index rebuild` — manual full regeneration of the context-tree
 * index (`index.html`).
 *
 * The index is normally regenerated automatically after each curate and
 * dream-finalize. This command exists for first-time adoption on an
 * existing tree, recovery after a best-effort regeneration failed, or
 * after manual edits to the tree. Pure filesystem — runs in-process, no
 * daemon connection required.
 */
export default class IndexRebuild extends Command {
  public static description = 'Rebuild the context-tree index (index.html) from the current set of topics.'
  public static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --format json',
  ]
  public static flags = {
    format: Flags.string({default: 'text', description: 'Output format (text or json)', options: ['text', 'json']}),
  }

  public async run(): Promise<void> {
    const {flags: raw} = await this.parse(IndexRebuild)
    const format = raw.format === 'json' ? 'json' : 'text'

    const projectRoot = resolveProjectRoot()
    const contextTreeRoot = join(projectRoot, BRV_DIR, CONTEXT_TREE_DIR)

    const result = await generateContextTreeIndex({
      contextTreeRoot,
      // Surface non-fatal walk problems (e.g. an unreadable subdirectory)
      // so a partial rebuild is diagnosable rather than silently truncated.
      log: (msg) => this.warn(msg),
      projectName: basename(projectRoot),
    })

    if (!result.ok) {
      if (format === 'json') {
        writeJsonResponse({command: 'index-rebuild', data: {error: result.error, status: 'error'}, success: false})
      } else {
        this.log(`✗ Index rebuild failed: ${result.error}`)
      }

      this.exit(1)
      return
    }

    if (format === 'json') {
      writeJsonResponse({
        command: 'index-rebuild',
        data: {
          domainCount: result.domainCount,
          status: 'ok',
          topicCount: result.topicCount,
          written: result.written,
        },
        success: true,
      })
    } else {
      const topicLabel = result.topicCount === 1 ? 'topic' : 'topics'
      const domainLabel = result.domainCount === 1 ? 'domain' : 'domains'
      this.log(
        `✓ Rebuilt index.html — ${result.topicCount} ${topicLabel} across ${result.domainCount} ${domainLabel}`,
      )
    }
  }
}

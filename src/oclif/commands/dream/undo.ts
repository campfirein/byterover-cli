import {Command, Flags} from '@oclif/core'

import type {ILogger} from '../../../agent/core/interfaces/i-logger.js'

import {NoOpLogger} from '../../../agent/core/interfaces/i-logger.js'
import {ConsoleLogger} from '../../../agent/infra/logger/console-logger.js'
import {undoLastDream} from '../../../server/infra/dream/dream-undo.js'
import {resolveProject} from '../../../server/infra/project/resolve-project.js'
import {writeJsonResponse} from '../../lib/json-response.js'
import {buildUndoDeps} from '../dream.js'

/**
 * Revert the most recent completed dream — restores any topics archived
 * during finalize (tool-mode) and any CONSOLIDATE/SYNTHESIZE writes from
 * legacy LLM-driven dreams. `brv curate` writes that the agent made
 * between `brv dream scan` and `brv dream finalize` are NOT rolled back
 * here — they are independent curate-log entries; use
 * `brv review reject <taskId>` for those. Mirrors `brv dream --undo`;
 * both call into the same `undoLastDream` helper.
 */
export default class DreamUndo extends Command {
  public static description = 'Revert the most recent completed dream (legacy LLM-driven or tool-mode).'
public static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --format json']
public static flags = {
    format: Flags.string({default: 'text', description: 'Output format (text or json)', options: ['text', 'json']}),
  }

  public async run(): Promise<void> {
    const {flags: raw} = await this.parse(DreamUndo)
    const format = raw.format === 'json' ? 'json' : 'text'

    const projectRoot = resolveProject()?.projectRoot ?? process.cwd()
    const logger: ILogger = format === 'json' ? new NoOpLogger() : new ConsoleLogger()
    const deps = await buildUndoDeps(projectRoot, logger)

    try {
      const result = await undoLastDream(deps)

      if (format === 'json') {
        writeJsonResponse({command: 'dream-undo', data: {...result, status: 'undone'}, success: true})
      } else {
        this.log(`Undone dream ${result.dreamId}`)
        this.log(`  Restored: ${result.restoredFiles.length} files`)
        this.log(`  Deleted: ${result.deletedFiles.length} files`)
        this.log(`  Restored archives: ${result.restoredArchives.length} files`)
        if (result.errors.length > 0) {
          this.log(`  Errors: ${result.errors.length}`)
          for (const e of result.errors) this.log(`    - ${e}`)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Undo failed'
      if (format === 'json') {
        writeJsonResponse({command: 'dream-undo', data: {error: message, status: 'error'}, success: false})
      } else {
        this.log(`Undo failed: ${message}`)
      }
    }
  }
}

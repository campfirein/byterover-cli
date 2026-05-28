import {Args, Command, Flags} from '@oclif/core'

import {writeJsonResponse} from '../lib/json-response.js'
import {readTopic, resolveProjectRoot} from '../lib/read-topic.js'

/**
 * `brv read <path>` — fetch a single topic from
 * `.brv/context-tree/<path>` as rendered markdown (HTML topics) or
 * raw markdown (MD topics).
 *
 * Thin wrapper over `readTopic` from the lib module. The command
 * is intentionally narrow: it reads one file and prints it. No
 * caching, no batch-read, no subtree listing — those are separate
 * primitives if/when needed.
 *
 * Primary consumer: the curate skill's UPDATE path, where the
 * calling agent needs to see an existing topic's content before
 * authoring a merged update. Today's `brv search` returns excerpts
 * only; `brv read` exists to surface the full topic cleanly.
 */
export default class Read extends Command {
  public static args = {
    path: Args.string({
      description: 'Topic path relative to .brv/context-tree/ (e.g., "security/auth.html")',
      required: true,
    }),
  }
  public static description = `Read a topic file from .brv/context-tree/

HTML topics route through the html-renderer to produce clean markdown that preserves bv-* element semantics (severity, id, subject/value). Markdown topics pass through unchanged. Pass --raw to get source bytes regardless of format.`
  public static examples = [
    '<%= config.bin %> <%= command.id %> security/auth.html',
    '<%= config.bin %> <%= command.id %> security/auth.html --format json',
    '<%= config.bin %> <%= command.id %> security/auth.html --raw',
  ]
  public static flags = {
    format: Flags.string({
      char: 'f',
      default: 'text',
      description: 'Output format',
      options: ['text', 'json'],
    }),
    raw: Flags.boolean({
      default: false,
      description: 'Return source bytes (no HTML→markdown rendering)',
    }),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(Read)
    const isJson = flags.format === 'json'

    const projectRoot = resolveProjectRoot()
    const result = await readTopic(projectRoot, args.path, {raw: flags.raw})

    if (result.ok) {
      if (isJson) {
        writeJsonResponse({
          command: 'read',
          data: {content: result.content, format: result.format, path: result.path},
          success: true,
        })
      } else {
        this.log(result.content)
      }

      return
    }

    if (isJson) {
      writeJsonResponse({
        command: 'read',
        data: {error: result.error, path: result.path},
        success: false,
      })
    } else {
      this.log(`Error (${result.error.kind}): ${result.error.message}`)
    }

    process.exitCode = 1
  }
}

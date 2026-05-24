import {Command, Flags} from '@oclif/core'

import {writeJsonResponse} from '../../lib/json-response.js'

/**
 * Tool-mode dream sessions are stateless on the daemon in v1 — the agent
 * holds session state between scan and finalize. This command exists for
 * surface symmetry with the proposal and to give us a place to hang a
 * persistent session listing in a follow-up.
 */
export default class DreamSessions extends Command {
  public static description =
    '[v1 stub] List active tool-mode dream sessions. Sessions are stateless on the daemon in v1; this command always returns an empty list.'
public static examples = [
    '# Plain text',
    '<%= config.bin %> <%= command.id %>',
    '',
    '# JSON for scripting',
    '<%= config.bin %> <%= command.id %> --format json',
  ]
public static flags = {
    format: Flags.string({default: 'text', description: 'Output format (text or json)', options: ['text', 'json']}),
  }

  public async run(): Promise<void> {
    const {flags: raw} = await this.parse(DreamSessions)
    const format = raw.format === 'json' ? 'json' : 'text'

    if (format === 'json') {
      writeJsonResponse({
        command: 'dream-sessions',
        data: {
          // Disclosed inline so machine-readable consumers that branch on
          // `sessions` length don't act on the empty array thinking the
          // daemon was queried — there's nothing to query in v1.
          note: 'v1: sessions are stateless on the daemon; this list is always empty.',
          sessions: [],
          status: 'ok',
        },
        success: true,
      })
    } else {
      this.log(
        'No active sessions.\n\n' +
          '(Tool-mode dream sessions are stateless on the daemon in v1 — the\n' +
          'agent holds the session id between `brv dream scan` and\n' +
          '`brv dream finalize`.)',
      )
    }
  }
}

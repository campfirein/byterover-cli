import {Args, Command, Flags} from '@oclif/core'

import type {
  ChannelOnboardRequest,
  ChannelOnboardResponse,
} from '../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelClientError, withChannelClient} from '../../lib/channel-client.js'

export default class ChannelOnboard extends Command {
  public static args = {
    name: Args.string({description: 'Profile name (used by `brv channel invite --profile <name>`)', required: true}),
  }
public static description = 'Probe an ACP agent and persist a driver profile (Phase 3)'
public static examples = [
    '<%= config.bin %> <%= command.id %> mock -- node test/fixtures/mock-acp.js',
    '<%= config.bin %> <%= command.id %> kimi -- kimi acp',
  ]
public static flags = {
    'display-name': Flags.string({description: 'Friendly display name (defaults to the profile name)'}),
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
  }
// Accept the trailing invocation tokens (after `--`).
  public static strict = false

  public async run(): Promise<void> {
    const {args, argv, flags} = await this.parse(ChannelOnboard)
    const tail = argv.slice(1).filter((v): v is string => typeof v === 'string')
    if (tail.length === 0) {
      this.error('Inline invocation is required: `brv channel onboard <name> -- <command> [args...]`', {exit: 1})
    }

    const [command, ...commandArgs] = tail

    try {
      const response = await withChannelClient(async (client) =>
        client.request<ChannelOnboardRequest, ChannelOnboardResponse>(ChannelEvents.ONBOARD, {
          displayName: flags['display-name'] ?? args.name,
          invocation: {args: commandArgs, command, cwd: process.cwd()},
          profileName: args.name,
        }),
      )

      if (flags.json) {
        this.log(JSON.stringify(response, undefined, 2))
        return
      }

      const {profile} = response
      const caps = profile.capabilities?.length ? `, capabilities: [${profile.capabilities.join(', ')}]` : ''
      this.log(`✓ Profile \`${profile.name}\` saved (class: ${profile.driverClass}${caps}).`)
      for (const d of response.diagnostics) {
        if (d.severity === 'info') continue
        this.log(`  [${d.severity}] ${d.message}`)
      }
    } catch (error) {
      this.handleError(error, flags.json)
    }
  }

  private handleError(error: unknown, asJson: boolean): never {
    if (error instanceof ChannelClientError) {
      // Slice 4.2: AUTH_REQUIRED gets a dedicated exit code (65, sysexits
      // EX_NOPERM) and a remediation hint derived from the agent's
      // advertised `terminal-auth` field meta if present.
      //
      // Use `process.exit(N)` rather than `this.exit(N)` because oclif's
      // `--json` mode intercepts `this.exit()` to render the error envelope
      // and coerces non-zero exit codes to 0 — defeating the whole point of
      // an exit-65 contract. `process.exit` bypasses oclif's lifecycle.
      if (error.code === 'ACP_AUTH_REQUIRED') {
        if (asJson) {
          this.log(JSON.stringify({code: error.code, details: error.details, error: error.message, success: false}))
        } else {
          this.logToStderr(`[AUTH_REQUIRED] ${error.message}`)
          const remediation = formatAuthRemediation(error.details)
          if (remediation !== undefined) this.logToStderr(`  → ${remediation}`)
        }

        // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
        process.exit(65)
      }

      // Slice 4.4: friendly message for binary-not-found.
      if (error.code === 'ACP_BINARY_NOT_FOUND') {
        if (asJson) {
          this.log(JSON.stringify({code: error.code, error: error.message, success: false}))
        } else {
          this.logToStderr(`[ACP_BINARY_NOT_FOUND] ${error.message}`)
          this.logToStderr('  → install the agent (e.g. `pipx install kimi-cli`) or fix your PATH and retry')
        }

        // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
        process.exit(1)
      }

      if (asJson) {
        this.log(JSON.stringify({code: error.code, error: error.message, success: false}))
      } else {
        this.logToStderr(`[${error.code}] ${error.message}`)
      }

      this.exit(1)
    }

    throw error
  }
}

type TerminalAuth = {
  args?: readonly string[]
  command: string
  env?: Readonly<Record<string, string>>
}

type AuthMethod = {
  fieldMeta?: {terminalAuth?: TerminalAuth}
  id?: string
  name?: string
}

const formatAuthRemediation = (details: unknown): string | undefined => {
  if (details === null || typeof details !== 'object') return undefined
  const methods = (details as {authMethods?: unknown}).authMethods
  if (!Array.isArray(methods) || methods.length === 0) return undefined

  // Preferred: structured terminal-auth invocation. Kimi-style ACP servers
  // typically DON'T include this nested shape — they flatten to `{id, name,
  // description, type, args, env}` at the top level.
  for (const m of methods as AuthMethod[]) {
    const terminal = m.fieldMeta?.terminalAuth
    if (terminal !== undefined && typeof terminal.command === 'string') {
      const tokens = [terminal.command, ...(terminal.args ?? [])]
      return `run \`${tokens.join(' ')}\` and rerun this onboard command`
    }
  }

  // Fallback 1: an agent-provided `description` (kimi's "Run `kimi login`..."
  // human-readable hint). This is the most useful actionable message for the
  // user in practice.
  for (const m of methods as {description?: unknown}[]) {
    if (typeof m.description === 'string' && m.description.length > 0) {
      return m.description
    }
  }

  // Fallback 2: completely generic last-resort.
  return "run the agent's login command and retry"
}

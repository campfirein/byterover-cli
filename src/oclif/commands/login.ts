/* eslint-disable camelcase */
import {Command, Flags} from '@oclif/core'

import {
  AuthEvents,
  type AuthLoginCompletedEvent,
  type AuthLoginWithApiKeyResponse,
  type AuthStartLoginResponse,
} from '../../shared/transport/events/auth-events.js'
import {buildCliMetadata} from '../lib/build-cli-metadata.js'
import {type DaemonClientOptions, formatConnectionError, withDaemonRetry} from '../lib/daemon-client.js'
import {writeJsonResponse} from '../lib/json-response.js'

const DEFAULT_OAUTH_TIMEOUT_MS = 5 * 60 * 1000

type OutputFormat = 'json' | 'text'

export interface LoginOAuthOptions extends DaemonClientOptions {
  /** Max time to wait for LOGIN_COMPLETED after the browser opens. */
  oauthTimeoutMs?: number
  /** Invoked with the auth URL once the daemon has started the flow. */
  onAuthUrl?: (authUrl: string) => void
}

export default class Login extends Command {
  public static description = 'Authenticate with ByteRover for cloud sync features (optional for local usage)'
  public static examples = [
    '# Browser OAuth (default)',
    '<%= config.bin %> <%= command.id %>',
    '',
    '# API key (for CI / headless environments)',
    '<%= config.bin %> <%= command.id %> --api-key <key>',
    '',
    '# JSON output (for automation)',
    '<%= config.bin %> <%= command.id %> --format json',
  ]
  public static flags = {
    'api-key': Flags.string({
      char: 'k',
      description:
        'API key for headless/CI login (get yours at https://app.byterover.dev/settings/keys). Omit to use the browser OAuth flow.',
    }),
    format: Flags.string({
      default: 'text',
      description: 'Output format (text or json)',
      options: ['text', 'json'],
    }),
  }

  /** Gates the OAuth flow. DISPLAY/WAYLAND_DISPLAY deliberately not checked — unset on macOS/Windows, would false-positive. */
  protected canOpenBrowser(): boolean {
    // Either stream not a TTY means piped/scripted/CI — no interactive user to complete OAuth.
    if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) return false
    // SSH has a TTY but can't reach the user's local browser.
    if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY) return false
    return true
  }

  protected async loginWithApiKey(
    apiKey: string,
    cliMetadata: ReturnType<typeof buildCliMetadata>,
    options?: DaemonClientOptions,
  ): Promise<AuthLoginWithApiKeyResponse> {
    return withDaemonRetry<AuthLoginWithApiKeyResponse>(
      async (client) =>
        client.requestWithAck<AuthLoginWithApiKeyResponse>(AuthEvents.LOGIN_WITH_API_KEY, {
          apiKey,
          cli_metadata: cliMetadata,
        }),
      options,
    )
  }

  protected async loginWithOAuth(
    cliMetadata: ReturnType<typeof buildCliMetadata>,
    options?: LoginOAuthOptions,
  ): Promise<AuthLoginCompletedEvent> {
    const timeoutMs = options?.oauthTimeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS

    return withDaemonRetry<AuthLoginCompletedEvent>(async (client) => {
      // Subscribe *before* initiating, so a fast callback cannot race past us.
      let unsubscribe: (() => void) | undefined
      let timer: NodeJS.Timeout | undefined
      const completion = new Promise<AuthLoginCompletedEvent>((resolve, reject) => {
        timer = setTimeout(() => {
          unsubscribe?.()
          timer = undefined
          reject(new Error(`Login timed out after ${Math.round(timeoutMs / 1000)}s`))
        }, timeoutMs)

        unsubscribe = client.on<AuthLoginCompletedEvent>(AuthEvents.LOGIN_COMPLETED, (data) => {
          if (timer) {
            clearTimeout(timer)
            timer = undefined
          }

          unsubscribe?.()
          resolve(data)
        })
      })

      try {
        const startResponse = await client.requestWithAck<AuthStartLoginResponse>(AuthEvents.START_LOGIN, {
          cli_metadata: cliMetadata,
        })
        options?.onAuthUrl?.(startResponse.authUrl)

        return await completion
      } catch (error) {
        if (timer) {
          clearTimeout(timer)
          timer = undefined
        }

        unsubscribe?.()
        throw error
      }
    }, options)
  }

  public async run(): Promise<void> {
    const {flags, metadata} = await this.parse(Login)
    const apiKey = flags['api-key']
    const format: OutputFormat = flags.format === 'json' ? 'json' : 'text'
    const cliMetadata = buildCliMetadata(this.id ?? 'login', {flags, metadata})

    if (!apiKey && !this.canOpenBrowser()) {
      this.emitError(
        format,
        'Cannot open a local browser here (non-interactive shell or SSH session). Use --api-key for headless login (get yours at https://app.byterover.dev/settings/keys).',
      )
      return
    }

    try {
      await (apiKey ? this.runApiKey(apiKey, format, cliMetadata) : this.runOAuth(format, cliMetadata))
    } catch (error) {
      const message = formatConnectionError(error)
      if (format === 'json') {
        this.emitError(format, message)
      } else {
        this.log(message)
      }
    }
  }

  private emitError(format: OutputFormat, message: string): void {
    if (format === 'json') {
      writeJsonResponse({command: 'login', data: {error: message}, success: false})
    } else {
      this.log(message)
    }
  }

  private emitSuccess(format: OutputFormat, userEmail: string | undefined): void {
    if (format === 'json') {
      writeJsonResponse({command: 'login', data: {userEmail}, success: true})
    } else {
      this.log(userEmail ? `Logged in as ${userEmail}` : 'Logged in successfully')
    }
  }

  private async runApiKey(
    apiKey: string,
    format: OutputFormat,
    cliMetadata: ReturnType<typeof buildCliMetadata>,
  ): Promise<void> {
    if (format === 'text') {
      this.log('Logging in...')
    }

    const response = await this.loginWithApiKey(apiKey, cliMetadata)

    if (response.success) {
      this.emitSuccess(format, response.userEmail)
    } else {
      this.emitError(format, response.error ?? 'Authentication failed')
    }
  }

  private async runOAuth(format: OutputFormat, cliMetadata: ReturnType<typeof buildCliMetadata>): Promise<void> {
    const onAuthUrl = (authUrl: string): void => {
      if (format === 'text') {
        this.log('Opening browser for authentication...')
        this.log(`If the browser did not open, visit: ${authUrl}`)
      }
    }

    const result = await this.loginWithOAuth(cliMetadata, {onAuthUrl})

    if (result.success) {
      this.emitSuccess(format, result.user?.email)
    } else {
      this.emitError(format, result.error ?? 'Authentication failed')
    }
  }
}

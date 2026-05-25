import {input, password, select, Separator} from '@inquirer/prompts'
import {Args, Command, Flags} from '@oclif/core'
import chalk from 'chalk'

import type {ProviderDTO, TeamDTO} from '../../../shared/transport/types/dto.js'

import {OAUTH_CALLBACK_TIMEOUT_MS} from '../../../shared/constants/oauth.js'
import {
  BillingEvents,
  type BillingSetPinnedTeamRequest,
  type BillingSetPinnedTeamResponse,
} from '../../../shared/transport/events/billing-events.js'
import {
  ModelEvents,
  type ModelListRequest,
  type ModelListResponse,
  type ModelSetActiveResponse,
} from '../../../shared/transport/events/model-events.js'
import {
  type ProviderAwaitOAuthCallbackResponse,
  type ProviderConnectResponse,
  type ProviderDisconnectResponse,
  ProviderEvents,
  type ProviderListResponse,
  type ProviderSetActiveResponse,
  type ProviderStartOAuthResponse,
  type ProviderSubmitOAuthCodeResponse,
  type ProviderValidateApiKeyResponse,
} from '../../../shared/transport/events/provider-events.js'
import {TeamEvents, type TeamListResponse} from '../../../shared/transport/events/team-events.js'
import {type DaemonClientOptions, withDaemonRetry} from '../../lib/daemon-client.js'
import {writeJsonResponse} from '../../lib/json-response.js'
import {
  createEscapeSignal,
  isEscBack,
  isPromptCancelled,
  validateUrl,
  wizardSelectTheme,
} from '../../lib/prompt-utils.js'
import {createSpinner} from '../../lib/spinner.js'

const BYTEROVER_PROVIDER_ID = 'byterover'

type ConnectInfo =
  | {kind: 'apikey'; model?: string; providerId: string; providerName: string}
  | {kind: 'oauth'; providerName: string; showInstructions: boolean}

export default class ProviderConnect extends Command {
  public static args = {
    provider: Args.string({
      description: 'Provider ID to connect (e.g., anthropic, openai, openrouter). Omit for interactive selection.',
      required: false,
    }),
  }
  public static description = 'Connect or switch to an LLM provider'
  public static examples = [
    '<%= config.bin %> providers connect',
    '<%= config.bin %> providers connect anthropic --api-key sk-xxx',
    '<%= config.bin %> providers connect openai --oauth',
    '<%= config.bin %> providers connect byterover',
    '<%= config.bin %> providers connect byterover --team acme',
    '<%= config.bin %> providers connect openai-compatible --base-url http://localhost:11434/v1 --api-key sk-xxx',
  ]
  public static flags = {
    'api-key': Flags.string({
      char: 'k',
      description: 'API key for the provider',
    }),
    'base-url': Flags.string({
      char: 'b',
      description: 'Base URL for OpenAI-compatible providers (e.g., http://localhost:11434/v1)',
    }),
    code: Flags.string({
      char: 'c',
      description:
        'Authorization code for code-paste OAuth providers (e.g., Anthropic). ' +
        'Not applicable to browser-callback providers like OpenAI — use --oauth without --code instead.',
      hidden: true,
    }),
    format: Flags.string({
      default: 'text',
      description: 'Output format (text or json)',
      options: ['text', 'json'],
    }),
    model: Flags.string({
      char: 'm',
      description: 'Model to set as active after connecting',
    }),
    oauth: Flags.boolean({
      default: false,
      description: 'Connect via OAuth (browser-based)',
    }),
    team: Flags.string({
      description: 'Pin this project to a billing team (byterover only). Accepts team name or slug.',
    }),
  }

  protected async applyTeamPin(team: string, options?: DaemonClientOptions): Promise<TeamDTO> {
    const teams = await this.fetchTeams(options)
    const match = this.matchTeam(teams, team)
    if (!match) {
      const list = teams.length === 0 ? '' : ` Available: ${teams.map((t) => t.displayName).join(', ')}.`
      throw new Error(`No team matched "${team}".${list}`)
    }

    await this.setBillingPin(match.id, options)
    return match
  }

  protected buildPinPayload(team: TeamDTO | undefined): Record<string, unknown> {
    if (!team) return {}
    return {team: {cleared: false, displayName: team.displayName, organizationId: team.id}}
  }

  protected async connectProvider(
    {apiKey, baseUrl, model, providerId}: {apiKey?: string; baseUrl?: string; model?: string; providerId: string},
    options?: DaemonClientOptions,
  ) {
    return withDaemonRetry(async (client) => {
      // 1. Verify provider exists
      const {providers} = await client.requestWithAck<ProviderListResponse>(ProviderEvents.LIST)
      const provider = providers.find((p) => p.id === providerId)
      if (!provider) {
        throw new Error(`Unknown provider "${providerId}". Run "brv providers list" to see available providers.`)
      }

      // 2. Validate base URL for openai-compatible
      if (providerId === 'openai-compatible') {
        if (!baseUrl && !provider.isConnected) {
          throw new Error(
            'Provider "openai-compatible" requires a base URL. Use the --base-url flag to provide one.' +
              '\nExample: brv providers connect openai-compatible --base-url http://localhost:11434/v1',
          )
        }

        if (baseUrl) {
          const validationResult = validateUrl(baseUrl)
          if (typeof validationResult === 'string') {
            throw new TypeError(validationResult)
          }
        }
      }

      // 3. Validate API key if provided and required (skip for openai-compatible)
      if (apiKey && provider.requiresApiKey) {
        const validation = await client.requestWithAck<ProviderValidateApiKeyResponse>(
          ProviderEvents.VALIDATE_API_KEY,
          {apiKey, providerId},
        )
        if (!validation.isValid) {
          throw new Error(validation.error ?? 'The API key provided is invalid. Please check and try again.')
        }
      } else if (!apiKey && provider.requiresApiKey && !provider.isConnected) {
        throw new Error(
          `Provider "${providerId}" requires an API key. Use the --api-key flag to provide one.` +
            (provider.apiKeyUrl ? `\nDon't have one? Get your API key at: ${provider.apiKeyUrl}` : ''),
        )
      }

      // 4. Connect or switch active provider
      const hasNewConfig = apiKey || baseUrl
      const response = await (provider.isConnected && !hasNewConfig
        ? client.requestWithAck<ProviderSetActiveResponse>(ProviderEvents.SET_ACTIVE, {providerId})
        : client.requestWithAck<ProviderConnectResponse>(ProviderEvents.CONNECT, {apiKey, baseUrl, providerId}))

      if (!response.success) {
        throw new Error(response.error ?? 'Failed to connect provider. Please try again.')
      }

      // 5. Set model if specified
      if (model) {
        await client.requestWithAck<ModelSetActiveResponse>(ModelEvents.SET_ACTIVE, {modelId: model, providerId})
      }

      return {model, providerId, providerName: provider.name}
    }, options)
  }

  protected async connectProviderOAuth(
    {code, providerId}: {code?: string; providerId: string},
    options?: DaemonClientOptions,
    onProgress?: (msg: string) => void,
  ) {
    return withDaemonRetry(async (client) => {
      const {providers} = await client.requestWithAck<ProviderListResponse>(ProviderEvents.LIST)
      const provider = providers.find((p) => p.id === providerId)
      if (!provider) {
        throw new Error(`Unknown provider "${providerId}". Run "brv providers list" to see available providers.`)
      }

      if (!provider.supportsOAuth) {
        throw new Error(`Provider "${providerId}" does not support OAuth. Use --api-key instead.`)
      }

      if (code && provider.oauthCallbackMode !== 'code-paste') {
        throw new Error(
          `Provider "${providerId}" uses browser-based OAuth and does not accept --code.\n` +
            `Run: brv providers connect ${providerId} --oauth`,
        )
      }

      if (code) {
        const response = await client.requestWithAck<ProviderSubmitOAuthCodeResponse>(
          ProviderEvents.SUBMIT_OAUTH_CODE,
          {code, providerId},
        )
        if (!response.success) {
          throw new Error(response.error ?? 'OAuth code submission failed')
        }

        return {providerName: provider.name, showInstructions: false}
      }

      const startResponse = await client.requestWithAck<ProviderStartOAuthResponse>(ProviderEvents.START_OAUTH, {
        providerId,
      })
      if (!startResponse.success) {
        throw new Error(startResponse.error ?? 'Failed to start OAuth flow')
      }

      onProgress?.(`\nOpen this URL to authenticate:\n  ${startResponse.authUrl}\n`)

      if (startResponse.callbackMode === 'auto') {
        onProgress?.('Waiting for authentication in browser...')
        const awaitResponse = await client.requestWithAck<ProviderAwaitOAuthCallbackResponse>(
          ProviderEvents.AWAIT_OAUTH_CALLBACK,
          {providerId},
          {timeout: OAUTH_CALLBACK_TIMEOUT_MS},
        )
        if (!awaitResponse.success) {
          throw new Error(awaitResponse.error ?? 'OAuth authentication failed')
        }

        return {providerName: provider.name, showInstructions: false}
      }

      onProgress?.('Copy the authorization code from the browser and run:')
      onProgress?.(`  brv providers connect ${providerId} --oauth --code <code>`)
      return {providerName: provider.name, showInstructions: true}
    }, options)
  }

  protected async disconnectProvider(providerId: string, options?: DaemonClientOptions): Promise<void> {
    await withDaemonRetry(async (client) => {
      await client.requestWithAck<ProviderDisconnectResponse>(ProviderEvents.DISCONNECT, {providerId})
    }, options)
  }

  protected async fetchModels(providerId: string, options?: DaemonClientOptions): Promise<ModelListResponse> {
    return withDaemonRetry(
      async (client) =>
        client.requestWithAck<ModelListResponse>(ModelEvents.LIST, {providerId} satisfies ModelListRequest),
      options,
    )
  }

  protected async fetchProviders(options?: DaemonClientOptions): Promise<ProviderDTO[]> {
    const {providers} = await withDaemonRetry(
      async (client) => client.requestWithAck<ProviderListResponse>(ProviderEvents.LIST),
      options,
    )
    return providers
  }

  protected async fetchTeams(options?: DaemonClientOptions): Promise<TeamDTO[]> {
    return withDaemonRetry(async (client) => {
      const response = await client.requestWithAck<TeamListResponse>(TeamEvents.LIST)
      if (response.error) throw new Error(response.error)
      return response.teams ?? []
    }, options)
  }

  protected logPinResult(team: TeamDTO | undefined): void {
    if (!team) return
    this.log(`ByteRover usage on this project will be billed to ${team.displayName}.`)
  }

  protected matchTeam(teams: readonly TeamDTO[], value: string): TeamDTO | undefined {
    const lower = value.toLowerCase()
    return (
      teams.find((t) => t.displayName.toLowerCase() === lower) ??
      teams.find((t) => t.name.toLowerCase() === lower)
    )
  }

  protected async promptForApiKey(providerName: string, apiKeyUrl?: string, signal?: AbortSignal): Promise<string> {
    this.log()
    const hint = apiKeyUrl ? ` (get one at ${apiKeyUrl}):` : ':'
    return password(
      {
        mask: true,
        message: `Enter API key for ${providerName}${chalk.dim(hint)}`,
      },
      {signal},
    )
  }

  protected async promptForAuthMethod(provider: ProviderDTO, signal?: AbortSignal): Promise<'api-key' | 'oauth'> {
    this.log()
    const oauthLabel = provider.oauthLabel ?? 'OAuth (browser-based)'

    return select(
      {
        choices: [
          {
            name: `API Key${provider.apiKeyUrl ? ` — get one at ${provider.apiKeyUrl}` : ''}`,
            value: 'api-key' as const,
          },
          {name: oauthLabel, value: 'oauth' as const},
        ],
        message: `How do you want to authenticate with ${provider.name}?`,
        theme: wizardSelectTheme,
      },
      {signal},
    )
  }

  protected async promptForBaseUrl(signal?: AbortSignal): Promise<string> {
    this.log()
    return input(
      {
        message: `Enter base URL ${chalk.dim('(e.g. http://localhost:11434/v1):')}`,
        required: true,
        validate: validateUrl,
      },
      {signal},
    )
  }

  protected async promptForConnectedAction(
    provider: ProviderDTO,
    signal?: AbortSignal,
  ): Promise<'activate' | 'disconnect' | 'reconfigure'> {
    this.log()
    const choices: {name: string; value: 'activate' | 'disconnect' | 'reconfigure'}[] = []

    if (!provider.isCurrent) {
      choices.push({name: 'Set as active', value: 'activate'})
    }

    if (provider.isConnected) {
      choices.push({name: 'Disconnect', value: 'disconnect'})
    }

    if (provider.requiresApiKey || provider.supportsOAuth) {
      choices.push({name: `Reconfigure ${provider.authMethod === 'oauth' ? 'OAuth' : 'API key'}`, value: 'reconfigure'})
    }

    return select(
      {
        choices,
        message: `${provider.name} is already connected. What would you like to do?`,
        theme: wizardSelectTheme,
      },
      {signal},
    )
  }

  protected async promptForModel(
    models: {id: string; name: string}[],
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    this.log()
    if (models.length === 0) {
      this.log(chalk.dim('No models available. Check your API key or provider configuration.'))
      // Trigger back-navigation to auth step by throwing cancel
      const error = new Error('No models available')
      error.name = 'AbortPromptError'
      throw error
    }

    return select(
      {
        choices: [{name: 'Skip (use default)', value: ''}, ...models.map((m) => ({name: m.name, value: m.id}))],
        loop: false,
        message: 'Select a model',
        theme: wizardSelectTheme,
      },
      {signal},
    ).then((v) => v || undefined)
  }

  protected async promptForOptionalApiKey(providerName: string, signal?: AbortSignal): Promise<string | undefined> {
    this.log()
    const value = await input(
      {message: `Enter API key for ${providerName} ${chalk.dim('(optional, press Enter to skip):')}`},
      {signal},
    )
    return value.trim() || undefined
  }

  protected async promptForProvider(providers: ProviderDTO[], signal?: AbortSignal): Promise<string> {
    this.log()
    const nameMaxChars = Math.max(...providers.map((p) => p.name.length))
    const popular = providers.filter((p) => p.category === 'popular')
    const other = providers.filter((p) => p.category === 'other')

    const formatChoice = (p: ProviderDTO) => ({
      name: `${p.name.padEnd(nameMaxChars + 3)} ${p.description}`,
      value: p.id,
    })

    return select(
      {
        choices: [
          new Separator('---------- Popular ----------'),
          ...popular.map((p) => formatChoice(p)),
          new Separator('\n---------- Others ----------'),
          ...other.map((p) => formatChoice(p)),
        ],
        loop: false,
        message: 'Select a provider',
        theme: wizardSelectTheme,
      },
      {signal},
    )
  }

  protected renderConnectSuccess(params: {
    connectInfo: ConnectInfo
    format: 'json' | 'text'
    pinnedTeam: TeamDTO | undefined
    providerId: string
  }): void {
    const {connectInfo, format, pinnedTeam, providerId} = params

    if (format === 'json') {
      const data: Record<string, unknown> = connectInfo.kind === 'oauth'
        ? {providerId}
        : {model: connectInfo.model, providerId: connectInfo.providerId, providerName: connectInfo.providerName}
      writeJsonResponse({command: 'providers connect', data: {...data, ...this.buildPinPayload(pinnedTeam)}, success: true})
      return
    }

    if (connectInfo.kind === 'oauth') {
      if (!connectInfo.showInstructions) {
        this.log(`Connected to ${connectInfo.providerName} via OAuth`)
      }
    } else {
      this.log(`Connected to ${connectInfo.providerName} (${connectInfo.providerId})`)
      if (connectInfo.model) {
        this.log(`Model set to: ${connectInfo.model}`)
      }
    }

    this.logPinResult(pinnedTeam)
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ProviderConnect)
    const providerId = args.provider
    const format: 'json' | 'text' = flags.format === 'json' ? 'json' : 'text'

    // Interactive mode: no provider arg
    if (!providerId) {
      if (format === 'json') {
        writeJsonResponse({
          command: 'providers connect',
          data: {error: 'Provider argument is required for JSON output'},
          success: false,
        })
        return
      }

      try {
        await this.runInteractive()
      } catch (error) {
        this.log(
          error instanceof Error
            ? error.message
            : 'An unexpected error occurred while connecting the provider. Please try again.',
        )
      }

      return
    }

    // Non-interactive mode: provider arg provided
    await this.runNonInteractive(
      providerId,
      {
        apiKey: flags['api-key'],
        baseUrl: flags['base-url'],
        code: flags.code,
        model: flags.model,
        oauth: flags.oauth,
        team: flags.team,
      },
      format,
    )
  }

  /**
   * Interactive flow with cancel-to-go-back navigation.
   * Step 1 (provider) ← Step 2 (auth) ← Step 3 (model)
   */
  protected async runInteractive(): Promise<void> {
    const esc = createEscapeSignal()
    const STEPS = ['provider', 'auth', 'model'] as const
    let stepIndex = 0
    let providers = await this.fetchProviders()
    let providerId: string | undefined
    let provider: ProviderDTO | undefined

    try {
      /* eslint-disable no-await-in-loop -- intentional sequential interactive wizard */
      while (stepIndex < STEPS.length) {
        const currentStep = STEPS[stepIndex]
        try {
          switch (currentStep) {
            case 'auth': {
              // If providerId or provider is not set, go back to provider step
              // eslint-disable-next-line max-depth
              if (!providerId || !provider) {
                stepIndex--
                break
              }

              const done = await this.runAuthStep(providerId, provider, esc.signal)
              // eslint-disable-next-line max-depth
              if (done) {
                stepIndex = STEPS.length // skip remaining steps
              }

              break
            }

            case 'model': {
              // If providerId is not set, go back to provider step
              // eslint-disable-next-line max-depth
              if (!providerId) {
                stepIndex = 0
                break
              }

              // ByteRover does not need model selection
              // eslint-disable-next-line max-depth
              if (providerId === 'byterover') break

              await this.runModelStep(providerId, esc.signal)
              break
            }

            case 'provider': {
              providerId = await this.promptForProvider(providers, esc.signal)
              provider = providers.find((p) => p.id === providerId)
              break
            }
          }

          stepIndex++
        } catch (error) {
          if (isEscBack(error)) {
            // Esc → go back one step
            if (stepIndex === 0) return
            esc.reset()
            stepIndex--
            // Re-fetch providers on back-navigation so isConnected states are fresh
            if (STEPS[stepIndex] === 'provider') {
              providers = await this.fetchProviders()
            }
          } else if (isPromptCancelled(error)) {
            // Ctrl+C → exit wizard
            return
          } else {
            throw error
          }
        }
      }
      /* eslint-enable no-await-in-loop */
    } finally {
      esc.cleanup()
    }
  }

  protected async runNonInteractive(
    providerId: string,
    flags: {
      apiKey: string | undefined
      baseUrl: string | undefined
      code: string | undefined
      model: string | undefined
      oauth: boolean
      team: string | undefined
    },
    format: 'json' | 'text',
  ): Promise<void> {
    const {apiKey, baseUrl, code, model, oauth, team} = flags

    if (oauth && apiKey) {
      const msg = 'Cannot use --oauth and --api-key together'
      if (format === 'json') {
        writeJsonResponse({command: 'providers connect', data: {error: msg}, success: false})
      } else {
        this.log(msg)
      }

      return
    }

    if (code && !oauth) {
      const msg = '--code requires the --oauth flag'
      if (format === 'json') {
        writeJsonResponse({command: 'providers connect', data: {error: msg}, success: false})
      } else {
        this.log(msg)
      }

      return
    }

    if (team !== undefined && providerId !== BYTEROVER_PROVIDER_ID) {
      const msg = `--team is only supported for the "${BYTEROVER_PROVIDER_ID}" provider.`
      if (format === 'json') {
        writeJsonResponse({command: 'providers connect', data: {error: msg}, success: false})
      } else {
        this.log(msg)
      }

      return
    }

    try {
      let connectInfo: ConnectInfo
      if (oauth) {
        const onProgress = format === 'text' ? (msg: string) => this.log(msg) : undefined
        const result = await this.connectProviderOAuth({code, providerId}, undefined, onProgress)
        connectInfo = {kind: 'oauth', providerName: result.providerName, showInstructions: result.showInstructions}
      } else {
        const result = await this.connectProvider({apiKey, baseUrl, model, providerId})
        connectInfo = {
          kind: 'apikey',
          model: result.model,
          providerId: result.providerId,
          providerName: result.providerName,
        }
      }

      const pinnedTeam = team === undefined ? undefined : await this.applyTeamPin(team)

      this.renderConnectSuccess({connectInfo, format, pinnedTeam, providerId})
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'An unexpected error occurred while connecting the provider. Please try again.'
      if (format === 'json') {
        writeJsonResponse({command: 'providers connect', data: {error: errorMessage}, success: false})
      } else {
        this.log(errorMessage)
      }
    }
  }

  protected async setBillingPin(teamId: string | undefined, options?: DaemonClientOptions): Promise<void> {
    await withDaemonRetry(async (client, projectRoot) => {
      if (!projectRoot) throw new Error('Failed to resolve project path for billing pin.')
      const request: BillingSetPinnedTeamRequest =
        teamId === undefined ? {projectPath: projectRoot} : {projectPath: projectRoot, teamId}
      const response = await client.requestWithAck<BillingSetPinnedTeamResponse>(
        BillingEvents.SET_PINNED_TEAM,
        request,
      )
      if (!response.success) {
        throw new Error(response.error ?? 'Failed to update billing pin.')
      }
    }, options)
  }

  /* eslint-disable no-await-in-loop -- intentional retry loop for interactive auth */
  /** Returns true when wizard should end (skip model step), false to continue to model step. */
  private async runAuthStep(providerId: string, provider: ProviderDTO, signal?: AbortSignal): Promise<boolean> {
    // Provider already connected — ask what to do
    if (provider.isConnected) {
      const action = await this.promptForConnectedAction(provider, signal)

      if (action === 'activate') {
        const spinner = createSpinner('Connecting...')
        const result = await this.connectProvider({providerId})
        spinner.clear()
        this.log(`Connected to ${result.providerName} (${result.providerId})`)
        return false
      }

      if (action === 'disconnect') {
        const spinner = createSpinner('Disconnecting...')
        await this.disconnectProvider(providerId)
        spinner.clear()
        this.log(`Disconnected from ${provider.name}`)
        return true
      }

      // reconfigure → fall through to auth flow below
    }

    // No API key required (e.g., ByteRover free) but not openai-compatible — connect directly
    if (!provider.requiresApiKey && !provider.supportsOAuth && providerId !== 'openai-compatible') {
      const spinner = createSpinner('Connecting...')
      const result = await this.connectProvider({providerId})
      spinner.clear()
      this.log(`Connected to ${result.providerName} (${result.providerId})`)
      return false
    }

    // Retry loop — on connection failure, show error and re-prompt credentials
    while (true) {
      // Choose auth method if provider supports both
      let authMethod: 'api-key' | 'oauth' = 'api-key'
      if (provider.supportsOAuth && provider.requiresApiKey) {
        authMethod = await this.promptForAuthMethod(provider, signal)
      } else if (provider.supportsOAuth) {
        authMethod = 'oauth'
      }

      try {
        if (authMethod === 'oauth') {
          const result = await this.connectProviderOAuth({providerId}, undefined, (msg) => this.log(msg))
          if (!result.showInstructions) {
            this.log(`Connected to ${result.providerName} via OAuth`)
          }

          return false
        }

        // API key flow
        const isOpenAiCompatible = providerId === 'openai-compatible'
        const baseUrl = isOpenAiCompatible ? await this.promptForBaseUrl(signal) : undefined
        const apiKey = isOpenAiCompatible
          ? await this.promptForOptionalApiKey(provider.name, signal)
          : await this.promptForApiKey(provider.name, provider.apiKeyUrl, signal)

        const spinner = createSpinner('Connecting...')
        const result = await this.connectProvider({apiKey, baseUrl, providerId})
        spinner.clear()
        this.log(`Connected to ${result.providerName} (${result.providerId})`)
        return false
      } catch (error) {
        // Prompt cancellation → propagate to state machine (go back to provider)
        if (isPromptCancelled(error)) throw error

        // Connection error → show message and retry auth
        this.log(error instanceof Error ? error.message : 'Connection failed. Please try again.')
      }
    }
  }

  /* eslint-enable no-await-in-loop */

  private async runModelStep(providerId: string, signal?: AbortSignal): Promise<void> {
    const spinner = createSpinner('Fetching models...')
    const modelList = await this.fetchModels(providerId)
    spinner.clear()
    const modelId = await this.promptForModel(modelList.models, signal)
    if (!modelId) return

    await withDaemonRetry(async (client) =>
      client.requestWithAck<ModelSetActiveResponse>(ModelEvents.SET_ACTIVE, {modelId, providerId}),
    )
    this.log(`Model set to: ${modelId}`)
  }
}

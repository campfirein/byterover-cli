/**
 * Provider Registry
 *
 * Defines available LLM providers that can be connected to byterover-cli.
 * Inspired by OpenCode's provider system.
 */

import {CHATGPT_OAUTH_ORIGINATOR} from '../../../../shared/constants/oauth.js'

/**
 * Configuration for a single OAuth authentication mode.
 */
export interface OAuthModeConfig {
  /** Auth URL for this mode */
  readonly authUrl: string
  /** Mode identifier (e.g. 'default', 'pro-max') */
  readonly id: string
  /** Display label (e.g. "Sign in with OpenAI") */
  readonly label: string
}

/**
 * OAuth configuration for a provider.
 */
export interface ProviderOAuthConfig {
  /** How the callback is received: local server ('auto') or user pastes code ('code-paste') */
  readonly callbackMode: 'auto' | 'code-paste'
  /** Port for local callback server (auto mode only) */
  readonly callbackPort?: number
  /** OAuth client ID */
  readonly clientId: string
  /** Whether to add `code=true` query param to auth URL (code-paste mode only — tells server to display paste-able code) */
  readonly codeDisplay?: boolean
  /** Default model when connected via OAuth (overrides ProviderDefinition.defaultModel) */
  readonly defaultModel?: string
  /** Extra query params appended to the authorization URL (provider-specific) */
  readonly extraParams?: Readonly<Record<string, string>>
  /** Supported OAuth modes (some providers have multiple) */
  readonly modes: readonly OAuthModeConfig[]
  /** OAuth redirect URI */
  readonly redirectUri: string
  /** OAuth scopes */
  readonly scopes: string
  /** Token endpoint content type: OpenAI = 'form', Anthropic = 'json' */
  readonly tokenContentType: 'form' | 'json'
  /** Token exchange endpoint */
  readonly tokenUrl: string
}

/**
 * Definition for an LLM provider.
 */
export interface ProviderDefinition {
  /** URL where users can get an API key */
  readonly apiKeyUrl?: string
  /** API base URL (empty for internal providers, SDK-managed for Google) */
  readonly baseUrl: string
  /** Category for grouping in UI */
  readonly category: 'other' | 'popular'
  /** Default model to use when first connected */
  readonly defaultModel?: string
  /** Short description */
  readonly description: string
  /** Environment variable names to check for API key auto-detection */
  readonly envVars?: readonly string[]
  /** Default headers for API requests */
  readonly headers: Readonly<Record<string, string>>
  /** Unique provider identifier */
  readonly id: string
  /** Endpoint to fetch available models */
  readonly modelsEndpoint: string
  /** Display name */
  readonly name: string
  /** OAuth configuration (only for OAuth-capable providers) */
  readonly oauth?: ProviderOAuthConfig
  /** Priority for display order (lower = higher priority) */
  readonly priority: number
}

/**
 * Registry of all available providers.
 * Order by priority for consistent display.
 */
export const PROVIDER_REGISTRY: Readonly<Record<string, ProviderDefinition>> = {
  anthropic: {
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    baseUrl: 'https://api.anthropic.com',
    category: 'popular',
    defaultModel: 'claude-sonnet-4-5-20250929',
    description: 'Claude models by Anthropic',
    envVars: ['ANTHROPIC_API_KEY'],
    headers: {},
    id: 'anthropic',
    modelsEndpoint: '/v1/models',
    name: 'Anthropic',
    priority: 2,
  },
  byterover: {
    baseUrl: '',
    category: 'popular',
    description: 'Built-in LLM, ByteRover account required. Limited free usage.',
    headers: {},
    id: 'byterover',
    modelsEndpoint: '',
    name: 'ByteRover',
    priority: 0,
  },
  cerebras: {
    apiKeyUrl: 'https://cloud.cerebras.ai/platform',
    baseUrl: 'https://api.cerebras.ai/v1',
    category: 'other',
    defaultModel: 'gpt-oss-120b',
    description: 'Fast inference on Cerebras hardware',
    envVars: ['CEREBRAS_API_KEY'],
    headers: {},
    id: 'cerebras',
    modelsEndpoint: '/models',
    name: 'Cerebras',
    priority: 14,
  },
  cohere: {
    apiKeyUrl: 'https://dashboard.cohere.com/api-keys',
    baseUrl: 'https://api.cohere.com/v2',
    category: 'other',
    defaultModel: 'command-a-03-2025',
    description: 'Command models by Cohere',
    envVars: ['COHERE_API_KEY'],
    headers: {},
    id: 'cohere',
    modelsEndpoint: '/models',
    name: 'Cohere',
    priority: 11,
  },
  deepinfra: {
    apiKeyUrl: 'https://deepinfra.com/dash/api_keys',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    category: 'other',
    defaultModel: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
    description: 'Affordable inference on open models',
    envVars: ['DEEPINFRA_API_KEY'],
    headers: {},
    id: 'deepinfra',
    modelsEndpoint: '/models',
    name: 'DeepInfra',
    priority: 10,
  },
  deepseek: {
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    baseUrl: 'https://api.deepseek.com/v1',
    category: 'other',
    defaultModel: 'deepseek-chat',
    description: 'DeepSeek V3 and R1 reasoning models',
    envVars: ['DEEPSEEK_API_KEY'],
    headers: {},
    id: 'deepseek',
    modelsEndpoint: '/models',
    name: 'DeepSeek',
    priority: 19,
  },
  glm: {
    apiKeyUrl: 'https://open.z.ai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    category: 'other',
    defaultModel: 'glm-4.7',
    description: 'GLM models by Zhipu AI',
    envVars: ['ZHIPU_API_KEY'],
    headers: {},
    id: 'glm',
    modelsEndpoint: '',
    name: 'GLM (Z.AI)',
    priority: 17,
  },
  'glm-coding-plan': {
    apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    category: 'other',
    defaultModel: 'glm-4.7',
    description: 'GLM models on the Z.AI Coding Plan subscription',
    envVars: ['ZHIPU_API_KEY'],
    headers: {},
    id: 'glm-coding-plan',
    modelsEndpoint: '',
    name: 'GLM Coding Plan (Z.AI)',
    priority: 17.5,
  },
  google: {
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    baseUrl: '',
    category: 'popular',
    defaultModel: 'gemini-3-flash-preview',
    description: 'Gemini models by Google',
    envVars: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    headers: {},
    id: 'google',
    modelsEndpoint: '',
    name: 'Google Gemini',
    priority: 4,
  },
  groq: {
    apiKeyUrl: 'https://console.groq.com/keys',
    baseUrl: 'https://api.groq.com/openai/v1',
    category: 'popular',
    defaultModel: 'openai/gpt-oss-120b',
    description: 'Fast inference on open models',
    envVars: ['GROQ_API_KEY'],
    headers: {},
    id: 'groq',
    modelsEndpoint: '/models',
    name: 'Groq',
    priority: 6,
  },
  minimax: {
    apiKeyUrl: 'https://platform.minimax.io',
    baseUrl: 'https://api.minimax.io/v1',
    category: 'other',
    defaultModel: 'MiniMax-M2.7',
    description: 'MiniMax AI models',
    envVars: ['MINIMAX_API_KEY'],
    headers: {},
    id: 'minimax',
    modelsEndpoint: '',
    name: 'MiniMax',
    priority: 16,
  },
  mistral: {
    apiKeyUrl: 'https://console.mistral.ai/api-keys',
    baseUrl: 'https://api.mistral.ai/v1',
    category: 'popular',
    defaultModel: 'mistral-large-latest',
    description: 'Mistral AI models',
    envVars: ['MISTRAL_API_KEY'],
    headers: {},
    id: 'mistral',
    modelsEndpoint: '/models',
    name: 'Mistral',
    priority: 7,
  },
  moonshot: {
    apiKeyUrl: 'https://platform.moonshot.ai/console/api-keys',
    baseUrl: 'https://api.moonshot.ai/v1',
    category: 'other',
    defaultModel: 'kimi-k2.5',
    description: 'Kimi models by Moonshot AI',
    envVars: ['MOONSHOT_API_KEY'],
    headers: {},
    id: 'moonshot',
    modelsEndpoint: '',
    name: 'Moonshot AI (Kimi)',
    priority: 18,
  },
  openai: {
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    baseUrl: 'https://api.openai.com/v1',
    category: 'popular',
    defaultModel: 'gpt-4.1',
    description: 'GPT models by OpenAI',
    envVars: ['OPENAI_API_KEY'],
    headers: {},
    id: 'openai',
    modelsEndpoint: '/models',
    name: 'OpenAI',
    oauth: {
      callbackMode: 'auto',
      callbackPort: 1455,
      // Public OAuth client ID (safe to commit — native app public client, no client secret)
      clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
      // OpenAI Codex model used for the ChatGPT OAuth (Codex CLI) flow
      defaultModel: 'gpt-5.4-mini',
      /* eslint-disable camelcase -- OAuth query params follow RFC 6749 naming */
      extraParams: {
        codex_cli_simplified_flow: 'true',
        id_token_add_organizations: 'true',
        originator: CHATGPT_OAUTH_ORIGINATOR,
      },
      /* eslint-enable camelcase */
      modes: [{authUrl: 'https://auth.openai.com/oauth/authorize', id: 'default', label: 'Sign in with OpenAI'}],
      redirectUri: 'http://localhost:1455/auth/callback',
      scopes: 'openid profile email offline_access',
      tokenContentType: 'form',
      tokenUrl: 'https://auth.openai.com/oauth/token',
    },
    priority: 3,
  },
  'openai-compatible': {
    baseUrl: '',
    category: 'other',
    description: 'OpenAI-compatible endpoint (Ollama, LM Studio, etc.)',
    envVars: ['OPENAI_COMPATIBLE_API_KEY'],
    headers: {},
    id: 'openai-compatible',
    modelsEndpoint: '/models',
    name: 'OpenAI Compatible',
    priority: 20,
  },
  openrouter: {
    apiKeyUrl: 'https://openrouter.ai/keys',
    baseUrl: 'https://openrouter.ai/api/v1',
    category: 'popular',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    description: 'Access 200+ models via aggregator',
    envVars: ['OPENROUTER_API_KEY'],
    headers: {
      'HTTP-Referer': 'https://byterover.dev',
      'X-Title': 'byterover-cli',
    },
    id: 'openrouter',
    modelsEndpoint: '/models',
    name: 'OpenRouter',
    priority: 1,
  },
  perplexity: {
    apiKeyUrl: 'https://www.perplexity.ai/settings/api',
    baseUrl: 'https://api.perplexity.ai',
    category: 'other',
    defaultModel: 'sonar-pro',
    description: 'Web search-augmented inference',
    envVars: ['PERPLEXITY_API_KEY'],
    headers: {},
    id: 'perplexity',
    modelsEndpoint: '',
    name: 'Perplexity',
    priority: 13,
  },
  requesty: {
    apiKeyUrl: 'https://app.requesty.ai/api-keys',
    baseUrl: 'https://router.requesty.ai/v1',
    category: 'popular',
    defaultModel: 'openai/gpt-4o-mini',
    description: 'Access 300+ models via the Requesty router',
    envVars: ['REQUESTY_API_KEY'],
    headers: {
      'HTTP-Referer': 'https://byterover.dev',
      'X-Title': 'byterover-cli',
    },
    id: 'requesty',
    modelsEndpoint: '/models',
    name: 'Requesty',
    priority: 1.5,
  },
  togetherai: {
    apiKeyUrl: 'https://api.together.ai/settings/api-keys',
    baseUrl: 'https://api.together.xyz/v1',
    category: 'other',
    defaultModel: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
    description: 'Open-source model inference',
    envVars: ['TOGETHER_API_KEY', 'TOGETHERAI_API_KEY'],
    headers: {},
    id: 'togetherai',
    modelsEndpoint: '/models',
    name: 'Together AI',
    priority: 12,
  },
  vercel: {
    apiKeyUrl: 'https://v0.dev/chat/settings/keys',
    baseUrl: 'https://api.v0.dev/v1',
    category: 'other',
    defaultModel: 'v0-1.5-md',
    description: 'Vercel AI-powered models',
    envVars: ['VERCEL_API_KEY'],
    headers: {},
    id: 'vercel',
    modelsEndpoint: '/models',
    name: 'Vercel',
    priority: 15,
  },
  xai: {
    apiKeyUrl: 'https://console.x.ai',
    baseUrl: 'https://api.x.ai/v1',
    category: 'popular',
    defaultModel: 'grok-3',
    description: 'Grok models by xAI',
    envVars: ['XAI_API_KEY'],
    headers: {},
    id: 'xai',
    modelsEndpoint: '/models',
    name: 'xAI (Grok)',
    priority: 5,
  },
}

/**
 * Get all providers sorted by priority.
 */
export function getProvidersSortedByPriority(): ProviderDefinition[] {
  return Object.values(PROVIDER_REGISTRY).sort((a, b) => a.priority - b.priority)
}

/**
 * Get providers grouped by category.
 */
export function getProvidersGroupedByCategory(): {
  other: ProviderDefinition[]
  popular: ProviderDefinition[]
} {
  const providers = getProvidersSortedByPriority()
  return {
    other: providers.filter((p) => p.category === 'other'),
    popular: providers.filter((p) => p.category === 'popular'),
  }
}

/**
 * Get a provider by ID.
 */
export function getProviderById(id: string): ProviderDefinition | undefined {
  return PROVIDER_REGISTRY[id]
}

/**
 * Check if a provider requires an API key.
 */
export function providerRequiresApiKey(id: string, authMethod?: 'api-key' | 'oauth'): boolean {
  if (authMethod === 'oauth') return false

  const provider = getProviderById(id)
  if (!provider) return false
  // Internal providers (byterover) don't need API keys.
  // OpenAI Compatible has optional API key (handled in provider-command).
  if (id === 'byterover' || id === 'openai-compatible') return false

  return true
}

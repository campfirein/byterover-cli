import {API_V1_PATH} from '../constants.js'

/**
 * Environment types supported by the CLI.
 */
type Environment = 'development' | 'production'

const isEnvironment = (value: unknown): value is Environment => value === 'development' || value === 'production'

/**
 * Current environment - set at runtime by the launcher scripts.
 * - `./bin/dev.js` sets BRV_ENV=development
 * - `./bin/run.js` sets BRV_ENV=production
 */
const envValue = process.env.BRV_ENV
export const ENVIRONMENT: Environment = isEnvironment(envValue) ? envValue : 'development'

/**
 * Environment-specific configuration.
 *
 * Base URL vars (BRV_IAM_BASE_URL, BRV_COGIT_BASE_URL, BRV_LLM_BASE_URL)
 * store only the root domain (e.g., http://localhost:8080).
 *
 * NOTE: The OIDC sub-path (/api/v1/oidc) is intentionally baked into the
 * derived OIDC URLs below because it is a fixed, auth-specific structure
 * that does not follow the general "API version at point of use" pattern.
 */
type EnvironmentConfig = {
  authorizationUrl: string
  billingBaseUrl: string
  clientId: string
  cogitBaseUrl: string
  gitRemoteBaseUrl: string
  hubRegistryUrl: string
  iamBaseUrl: string
  issuerUrl: string
  llmBaseUrl: string
  scopes: string[]
  tokenUrl: string
  webAppUrl: string
}

/**
 * Non-infrastructure config that stays in source (same across envs or not sensitive).
 */
const DEFAULTS = {
  clientId: 'byterover-cli-client',
  hubRegistryUrl: 'https://hub.byterover.dev/r/registry.json',
  scopes: {
    development: ['read', 'write', 'debug'],
    production: ['read', 'write'],
  },
} as const

const normalizeUrl = (url: string): string => url.replace(/\/+$/, '')

const assertRootDomain = (name: string, url: string): void => {
  if (new URL(url).pathname !== '/') {
    throw new Error(
      `${name} must not include a path component. Provide the root domain only (e.g., https://example.com).`,
    )
  }
}

/**
 * Reads a required environment variable and normalizes it by removing any trailing slash.
 * This normalization applies to all required variables (including BRV_GIT_REMOTE_BASE_URL
 * and BRV_WEB_APP_URL, which may carry paths) to prevent double slashes when joining URLs.
 */
const readRequiredEnv = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. Ensure .env files are loaded via dotenv.`)
  }

  return normalizeUrl(value)
}

export const getCurrentConfig = (): EnvironmentConfig => {
  const iamBaseUrl = readRequiredEnv('BRV_IAM_BASE_URL')
  assertRootDomain('BRV_IAM_BASE_URL', iamBaseUrl)

  const cogitBaseUrl = readRequiredEnv('BRV_COGIT_BASE_URL')
  assertRootDomain('BRV_COGIT_BASE_URL', cogitBaseUrl)

  const billingBaseUrl = readRequiredEnv('BRV_BILLING_BASE_URL')
  assertRootDomain('BRV_BILLING_BASE_URL', billingBaseUrl)

  const oidcBase = `${iamBaseUrl}${API_V1_PATH}/oidc`

  return {
    authorizationUrl: `${oidcBase}/authorize`,
    billingBaseUrl,
    clientId: DEFAULTS.clientId,
    cogitBaseUrl,
    gitRemoteBaseUrl: readRequiredEnv('BRV_GIT_REMOTE_BASE_URL'),
    hubRegistryUrl: DEFAULTS.hubRegistryUrl,
    iamBaseUrl,
    issuerUrl: oidcBase,
    llmBaseUrl: readRequiredEnv('BRV_LLM_BASE_URL'),
    scopes: [...DEFAULTS.scopes[ENVIRONMENT]],
    tokenUrl: `${oidcBase}/token`,
    webAppUrl: readRequiredEnv('BRV_WEB_APP_URL'),
  }
}

export const getGitRemoteBaseUrl = (): string =>
  process.env.BRV_GIT_REMOTE_BASE_URL ?? 'https://byterover.dev'

export const isDevelopment = (): boolean => ENVIRONMENT === 'development'

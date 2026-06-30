import {API_V1_PATH} from '../constants.js'
import {processLog} from '../utils/process-logger.js'

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
  /**
   * Resolved `BRV_ANALYTICS_BASE_URL`. `undefined` means "no outbound
   * shipping" — the env var is absent, empty, whitespace-only, or
   * malformed. There is NO code-side fallback to a shared default; see
   * `resolveAnalyticsBaseUrl` below for the rationale. Consumers
   * downstream MUST handle the `undefined` case
   * (`wireAnalyticsHttpSender` swaps in `DrainingAnalyticsSender`; the
   * status snapshot coalesces to `''` and surfaces `(not configured)`).
   */
  analyticsBaseUrl: string | undefined
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
 *
 * `BRV_ANALYTICS_BASE_URL` is intentionally NOT in this table; see
 * `resolveAnalyticsBaseUrl` for the env-only resolution rule.
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

/**
 * Resolve `BRV_ANALYTICS_BASE_URL` with no code-side fallback.
 *
 *   - unset (env var missing)             -> `undefined` (silent)
 *   - empty string or whitespace only     -> `undefined` (silent)
 *   - `URL.canParse(value)` rejects       -> `undefined` + one warning
 *   - valid URL                           -> normalize trailing slash and return
 *
 * Production builds inject `BRV_ANALYTICS_BASE_URL` at build time. A
 * missing env means the build is misconfigured (a fork stripped the
 * vars, a CI image dropped them). A code-side fallback to a shared
 * upstream endpoint would silently route that build's events to the
 * wrong backend — privacy leak and telemetry pollution. Unset and empty
 * are silent because they are legitimate states for forks, CI, and
 * air-gapped installs; only malformed input (a user-error signal) emits
 * a warning.
 *
 * The second parameter is a test-only seam so unit tests can assert the
 * warning surface without touching the `processLog` session-file cache;
 * production callers MUST NOT override it.
 *
 * @internal
 */
export const resolveAnalyticsBaseUrl = (
  raw: string | undefined,
  log: (message: string) => void = processLog,
): string | undefined => {
  const trimmed = raw?.trim()
  if (trimmed === undefined || trimmed === '') return undefined

  if (!URL.canParse(trimmed)) {
    log(
      `[Environment] BRV_ANALYTICS_BASE_URL is malformed (${JSON.stringify(trimmed)}); remote analytics shipping disabled. Local JSONL tracking continues.`,
    )
    return undefined
  }

  return normalizeUrl(trimmed)
}

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

  const analyticsBaseUrl = resolveAnalyticsBaseUrl(process.env.BRV_ANALYTICS_BASE_URL)

  return {
    analyticsBaseUrl,
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

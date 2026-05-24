import {expect} from 'chai'

describe('Environment Configuration', () => {
  const ENV_VARS = {
    BRV_BILLING_BASE_URL: 'https://billing.test',
    BRV_COGIT_BASE_URL: 'https://cogit.test',
    BRV_GIT_REMOTE_BASE_URL: 'https://cogit-git.test',
    BRV_IAM_BASE_URL: 'https://iam.test',
    BRV_LLM_BASE_URL: 'https://llm.test',
    BRV_WEB_APP_URL: 'https://app.test',
  }

  const ALL_KEYS = ['BRV_ENV', ...Object.keys(ENV_VARS)]
  const savedEnvVars: Record<string, string | undefined> = {}

  before(() => {
    for (const key of ALL_KEYS) {
      savedEnvVars[key] = process.env[key]
    }
  })

  after(() => {
    for (const key of ALL_KEYS) {
      if (savedEnvVars[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnvVars[key]
      }
    }
  })

  beforeEach(() => {
    // Set all required env vars for each test
    for (const [key, value] of Object.entries(ENV_VARS)) {
      process.env[key] = value
    }
  })

  afterEach(() => {
    delete process.env.BRV_ENV
    for (const key of Object.keys(ENV_VARS)) {
      delete process.env[key]
    }
  })

  describe('ENVIRONMENT', () => {
    it('should default to development when BRV_ENV is not set', async () => {
      delete process.env.BRV_ENV

      const {ENVIRONMENT} = await import(`../../../src/server/config/environment.js?t=${Date.now()}`)

      expect(ENVIRONMENT).to.equal('development')
    })

    it('should be production when BRV_ENV is production', async () => {
      process.env.BRV_ENV = 'production'

      const {ENVIRONMENT} = await import(`../../../src/server/config/environment.js?t=${Date.now()}`)

      expect(ENVIRONMENT).to.equal('production')
    })

    it('should default to development for invalid BRV_ENV values', async () => {
      process.env.BRV_ENV = 'staging'

      const {ENVIRONMENT} = await import(`../../../src/server/config/environment.js?t=${Date.now()}`)

      expect(ENVIRONMENT).to.equal('development')
    })
  })

  describe('getCurrentConfig', () => {
    it('should read all URL properties from process.env', async () => {
      delete process.env.BRV_ENV

      const {getCurrentConfig} = await import(`../../../src/server/config/environment.js?t=${Date.now()}`)
      const config = getCurrentConfig()

      expect(config.iamBaseUrl).to.equal('https://iam.test')
      expect(config.authorizationUrl).to.equal('https://iam.test/api/v1/oidc/authorize')
      expect(config.cogitBaseUrl).to.equal('https://cogit.test')
      expect(config.gitRemoteBaseUrl).to.equal('https://cogit-git.test')
      expect(config.issuerUrl).to.equal('https://iam.test/api/v1/oidc')
      expect(config.llmBaseUrl).to.equal('https://llm.test')
      expect(config.tokenUrl).to.equal('https://iam.test/api/v1/oidc/token')
      expect(config.webAppUrl).to.equal('https://app.test')
    })

    it('should return clientId from source', async () => {
      delete process.env.BRV_ENV

      const {getCurrentConfig} = await import(`../../../src/server/config/environment.js?t=${Date.now()}`)
      const config = getCurrentConfig()

      expect(config.clientId).to.equal('byterover-cli-client')
    })

    it('should return hubRegistryUrl from source', async () => {
      delete process.env.BRV_ENV

      const {getCurrentConfig} = await import(`../../../src/server/config/environment.js?t=${Date.now()}`)
      const config = getCurrentConfig()

      expect(config.hubRegistryUrl).to.equal('https://hub.byterover.dev/r/registry.json')
    })

    it('should return development scopes when BRV_ENV is not set', async () => {
      delete process.env.BRV_ENV

      const {getCurrentConfig} = await import(`../../../src/server/config/environment.js?t=${Date.now()}`)
      const config = getCurrentConfig()

      expect(config.scopes).to.deep.equal(['read', 'write', 'debug'])
    })

    it('should return production scopes when BRV_ENV is production', async () => {
      process.env.BRV_ENV = 'production'

      const {getCurrentConfig} = await import(`../../../src/server/config/environment.js?t=${Date.now()}`)
      const config = getCurrentConfig()

      expect(config.scopes).to.deep.equal(['read', 'write'])
    })

    describe('Missing required environment variables', () => {
      const requiredVars = [
        'BRV_COGIT_BASE_URL',
        'BRV_GIT_REMOTE_BASE_URL',
        'BRV_IAM_BASE_URL',
        'BRV_LLM_BASE_URL',
        'BRV_WEB_APP_URL',
      ]

      for (const envVar of requiredVars) {
        it(`should throw when ${envVar} is missing`, async () => {
          delete process.env.BRV_ENV

          // Clear all then set all but one
          for (const v of requiredVars) process.env[v] = 'http://test.host'
          delete process.env[envVar]

          const {getCurrentConfig} = await import(`../../../src/server/config/environment.js?t=${Date.now()}`)
          expect(() => getCurrentConfig()).to.throw(`Missing required environment variable: ${envVar}`)
        })
      }
    })

    it('should normalize trailing slashes in all required env vars', async () => {
      process.env.BRV_IAM_BASE_URL = 'https://iam.test/'
      process.env.BRV_COGIT_BASE_URL = 'https://cogit.test/'
      process.env.BRV_LLM_BASE_URL = 'https://llm.test/'
      process.env.BRV_WEB_APP_URL = 'https://app.test/'
      process.env.BRV_GIT_REMOTE_BASE_URL = 'https://git.test/'

      const {getCurrentConfig} = await import(`../../../src/server/config/environment.js?t=${Date.now()}`)
      const config = getCurrentConfig()

      expect(config.iamBaseUrl).to.equal('https://iam.test')
      expect(config.cogitBaseUrl).to.equal('https://cogit.test')
      expect(config.llmBaseUrl).to.equal('https://llm.test')
      expect(config.webAppUrl).to.equal('https://app.test')
      expect(config.gitRemoteBaseUrl).to.equal('https://git.test')
      expect(config.authorizationUrl).to.equal('https://iam.test/api/v1/oidc/authorize')
    })

    it('should strip multiple consecutive trailing slashes', async () => {
      process.env.BRV_IAM_BASE_URL = 'https://iam.test//'

      const {getCurrentConfig} = await import(`../../../src/server/config/environment.js?t=${Date.now()}`)
      const config = getCurrentConfig()

      expect(config.iamBaseUrl).to.equal('https://iam.test')
      expect(config.authorizationUrl).to.equal('https://iam.test/api/v1/oidc/authorize')
    })

    it('should throw when BRV_IAM_BASE_URL contains a path component', async () => {
      process.env.BRV_IAM_BASE_URL = 'https://iam.test/api/v1/'

      const {getCurrentConfig} = await import(`../../../src/server/config/environment.js?t=${Date.now()}`)

      expect(() => getCurrentConfig()).to.throw('BRV_IAM_BASE_URL must not include a path component')
    })

    it('should throw when BRV_COGIT_BASE_URL contains a path component', async () => {
      process.env.BRV_COGIT_BASE_URL = 'https://cogit.test/api/v1/'

      const {getCurrentConfig} = await import(`../../../src/server/config/environment.js?t=${Date.now()}`)

      expect(() => getCurrentConfig()).to.throw('BRV_COGIT_BASE_URL must not include a path component')
    })

    it('should throw when a required env var is whitespace only', async () => {
      process.env.BRV_IAM_BASE_URL = '   '

      const {getCurrentConfig} = await import(`../../../src/server/config/environment.js?t=${Date.now()}`)

      expect(() => getCurrentConfig()).to.throw('Missing required environment variable: BRV_IAM_BASE_URL')
    })
  })
})

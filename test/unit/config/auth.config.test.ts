import {expect} from 'chai'
import sinon, {restore, stub} from 'sinon'

import {getAuthConfig} from '../../../src/server/config/auth.config.js'
import {IOidcDiscoveryService} from '../../../src/server/core/interfaces/auth/i-oidc-discovery-service.js'

describe('Auth Configuration', () => {
  let discoveryService: IOidcDiscoveryService
  let consoleWarnStub: sinon.SinonStub

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
    // Set all required env vars
    for (const [key, value] of Object.entries(ENV_VARS)) {
      process.env[key] = value
    }

    delete process.env.BRV_ENV

    // Stub console.warn to suppress output
    consoleWarnStub = stub(console, 'warn')

    // Create mock discovery service
    discoveryService = {
      discover: stub().resolves({
        authorizationEndpoint: 'https://discovered.example.com/authorize',
        issuer: 'https://discovered.example.com',
        scopesSupported: ['read', 'write', 'admin'],
        tokenEndpoint: 'https://discovered.example.com/token',
      }),
    }
  })

  afterEach(() => {
    consoleWarnStub.restore()

    delete process.env.BRV_ENV
    for (const key of Object.keys(ENV_VARS)) {
      delete process.env[key]
    }

    restore()
  })

  describe('successful discovery', () => {
    it('should use discovered endpoints', async () => {
      const config = await getAuthConfig(discoveryService)

      expect(config.authorizationUrl).to.equal('https://discovered.example.com/authorize')
      expect(config.tokenUrl).to.equal('https://discovered.example.com/token')
    })

    it('should use environment-specific clientId', async () => {
      const config = await getAuthConfig(discoveryService)

      expect(config.clientId).to.equal('byterover-cli-client')
    })

    it('should use environment-specific scopes', async () => {
      const config = await getAuthConfig(discoveryService)

      expect(config.scopes).to.include('read')
      expect(config.scopes).to.include('write')
      expect(config.scopes).to.include('debug')
    })

    it('should not set clientSecret for public client', async () => {
      const config = await getAuthConfig(discoveryService)

      expect(config.clientSecret).to.be.undefined
    })
  })

  describe('discovery failure fallback', () => {
    beforeEach(() => {
      // Mock discovery to fail with non-network error
      discoveryService.discover = stub().rejects(new Error('Discovery failed'))
    })

    it('should fallback to env var URLs when discovery fails', async () => {
      const config = await getAuthConfig(discoveryService)

      expect(config.authorizationUrl).to.equal('https://iam.test/api/v1/oidc/authorize')
      expect(config.tokenUrl).to.equal('https://iam.test/api/v1/oidc/token')
    })

    it('should still use environment-specific clientId and scopes in fallback', async () => {
      const config = await getAuthConfig(discoveryService)

      expect(config.clientId).to.equal('byterover-cli-client')
      expect(config.scopes).to.include('read')
      expect(config.scopes).to.include('write')
      expect(config.scopes).to.include('debug')
    })

    it('should throw on network errors', async () => {
      discoveryService.discover = stub().rejects(new Error('getaddrinfo ENOTFOUND iam.test'))

      try {
        await getAuthConfig(discoveryService)
        expect.fail('Expected getAuthConfig to throw')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        if (error instanceof Error) {
          expect(error.message).to.include('Network error')
        }
      }
    })
  })

  describe('redirectUri', () => {
    it('should not set redirectUri (determined at runtime)', async () => {
      const config = await getAuthConfig(discoveryService)

      expect(config.redirectUri).to.be.undefined
    })
  })
})

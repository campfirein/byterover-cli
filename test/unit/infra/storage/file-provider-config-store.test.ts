import {expect} from 'chai'
import {mkdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {FileProviderConfigStoreDeps} from '../../../../src/server/infra/storage/file-provider-config-store.js'

import {FileProviderConfigStore} from '../../../../src/server/infra/storage/file-provider-config-store.js'

describe('FileProviderConfigStore', () => {
  let tempDir: string
  let deps: FileProviderConfigStoreDeps

  beforeEach(async () => {
    tempDir = join(tmpdir(), `brv-provider-config-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tempDir, {recursive: true})

    deps = {
      getConfigDir: () => tempDir,
      getConfigPath: () => join(tempDir, 'providers.json'),
    }
  })

  afterEach(async () => {
    try {
      await rm(tempDir, {force: true, recursive: true})
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('disconnectProvider with details', () => {
    it('should round-trip a lastDisconnect tombstone through save/load', async () => {
      const store = new FileProviderConfigStore(deps)
      await store.connectProvider('openai', {authMethod: 'oauth', oauthAccountId: 'acct_123'})

      await store.disconnectProvider('openai', {
        errorCode: 'invalid_grant',
        reason: 'OAuth token refresh failed',
        statusCode: 400,
      })

      // Fresh store instance forces a read from disk (no cache reuse)
      const reloaded = await new FileProviderConfigStore(deps).read()

      expect(reloaded.isProviderConnected('openai')).to.be.false
      const entry = reloaded.providers.openai
      expect(entry).to.not.be.undefined
      expect(entry.lastDisconnect?.reason).to.equal('OAuth token refresh failed')
      expect(entry.lastDisconnect?.errorCode).to.equal('invalid_grant')
      expect(entry.lastDisconnect?.statusCode).to.equal(400)
      expect(entry.lastDisconnect?.at).to.be.a('string')
      // Last-known authMethod is preserved so a reconnect hint can be built
      expect(entry.authMethod).to.equal('oauth')
    })

    it('should remove the entry entirely when details are omitted', async () => {
      const store = new FileProviderConfigStore(deps)
      await store.connectProvider('openai', {authMethod: 'oauth'})

      await store.disconnectProvider('openai')

      const reloaded = await new FileProviderConfigStore(deps).read()
      expect(reloaded.providers.openai).to.be.undefined
      expect(reloaded.isProviderConnected('openai')).to.be.false
    })
  })

  describe('backward compatibility', () => {
    it('should load an existing providers.json that has no lastDisconnect field', async () => {
      const legacyConfig = {
        activeProvider: 'openai',
        providers: {
          openai: {
            activeModel: 'some-model',
            authMethod: 'oauth',
            connectedAt: '2025-01-01T00:00:00.000Z',
            favoriteModels: [],
            oauthAccountId: 'acct_legacy',
            recentModels: [],
          },
        },
      }
      await writeFile(join(tempDir, 'providers.json'), JSON.stringify(legacyConfig, null, 2), 'utf8')

      const config = await new FileProviderConfigStore(deps).read()

      // Old file loads unchanged: provider is connected and has no tombstone
      expect(config.isProviderConnected('openai')).to.be.true
      expect(config.providers.openai.lastDisconnect).to.be.undefined
      expect(config.providers.openai.authMethod).to.equal('oauth')
      expect(config.activeProvider).to.equal('openai')
    })
  })
})

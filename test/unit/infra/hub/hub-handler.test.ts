/* eslint-disable camelcase */
import {expect} from 'chai'
import nock from 'nock'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {IHubKeychainStore} from '../../../../src/server/core/interfaces/hub/i-hub-keychain-store.js'
import type {IHubRegistryConfigStore} from '../../../../src/server/core/interfaces/hub/i-hub-registry-config-store.js'
import type {ITransportServer} from '../../../../src/server/core/interfaces/transport/i-transport-server.js'
import type {HubInstallService} from '../../../../src/server/infra/hub/hub-install-service.js'

import {ProxyConfig} from '../../../../src/server/infra/http/proxy-config.js'
import {HubHandler} from '../../../../src/server/infra/transport/handlers/hub-handler.js'

const VALID_REGISTRY_RESPONSE = {
  entries: [
    {
      author: {name: 'Test', url: 'https://test.com'},
      category: 'test',
      dependencies: [],
      description: 'Test entry',
      file_tree: [{name: 'SKILL.md', url: 'https://example.com/SKILL.md'}],
      id: 'test-entry',
      license: 'MIT',
      long_description: 'Test',
      manifest_url: 'https://example.com/manifest.json',
      metadata: {use_cases: ['test']},
      name: 'Test Entry',
      path_url: 'https://example.com/path',
      readme_url: 'https://example.com/README.md',
      tags: ['test'],
      type: 'agent-skill' as const,
      version: '1.0.0',
    },
  ],
  version: '1.0.0',
}

describe('HubHandler', () => {
  let sandbox: SinonSandbox
  let transport: {
    broadcast: SinonStub
    onRequest: SinonStub
  }
  let installService: {
    install: SinonStub
  }
  let hubRegistryConfigStore: {
    addRegistry: SinonStub
    getRegistries: SinonStub
    removeRegistry: SinonStub
  }
  let hubKeychainStore: {
    deleteToken: SinonStub
    getToken: SinonStub
    setToken: SinonStub
  }
  let resolveProjectPath: SinonStub

  // Captures the handler callbacks registered via transport.onRequest
  let handlers: Record<string, (...args: unknown[]) => Promise<unknown>>

  beforeEach(async () => {
    sandbox = createSandbox()
    sandbox.stub(ProxyConfig, 'getProxyAgent').returns(undefined as never)

    handlers = {}
    transport = {
      broadcast: sandbox.stub(),
      onRequest: sandbox.stub().callsFake((event: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        handlers[event] = handler
      }),
    }

    installService = {
      install: sandbox.stub().resolves({installedFiles: [], message: 'Installed'}),
    }

    hubRegistryConfigStore = {
      addRegistry: sandbox.stub().resolves(),
      getRegistries: sandbox.stub().resolves([]),
      removeRegistry: sandbox.stub().resolves(),
    }

    hubKeychainStore = {
      deleteToken: sandbox.stub().resolves(),
      getToken: sandbox.stub().resolves(),
      setToken: sandbox.stub().resolves(),
    }

    resolveProjectPath = sandbox.stub().returns('/test/project')

    const handler = new HubHandler({
      hubInstallService: installService as unknown as HubInstallService,
      hubKeychainStore: hubKeychainStore as unknown as IHubKeychainStore,
      hubRegistryConfigStore: hubRegistryConfigStore as unknown as IHubRegistryConfigStore,
      officialRegistryUrl: 'https://example.com/registry.json',
      registryTimeoutMs: 50,
      resolveProjectPath,
      transport: transport as unknown as ITransportServer,
    })

    await handler.setup()
  })

  afterEach(() => {
    sandbox.restore()
    nock.cleanAll()
  })

  describe('hub:list', () => {
    it('should register handler', () => {
      expect(handlers['hub:list']).to.be.a('function')
    })

    it('should broadcast progress before fetching entries', async () => {
      nock('https://example.com').get('/registry.json').reply(200, VALID_REGISTRY_RESPONSE)

      await handlers['hub:list']()

      expect(transport.broadcast.calledWith('hub:list:progress', {message: 'Fetching hub entries...', step: 'fetching'})).to.be.true
    })
  })

  describe('hub:install', () => {
    it('should register handler', () => {
      expect(handlers['hub:install']).to.be.a('function')
    })

    it('defaults global-only skill agents (Hermes) to global scope when scope is omitted', async () => {
      nock('https://example.com').get('/registry.json').reply(200, VALID_REGISTRY_RESPONSE)

      await handlers['hub:install']({agent: 'Hermes', entryId: 'test-entry'}, 'client-1')

      expect(installService.install.calledOnce).to.be.true
      expect(installService.install.firstCall.args[0].scope).to.equal('global')
    })

    it('defaults project-capable skill agents (Claude Code) to project scope when scope is omitted', async () => {
      nock('https://example.com').get('/registry.json').reply(200, VALID_REGISTRY_RESPONSE)

      await handlers['hub:install']({agent: 'Claude Code', entryId: 'test-entry'}, 'client-1')

      expect(installService.install.calledOnce).to.be.true
      expect(installService.install.firstCall.args[0].scope).to.equal('project')
    })

    it('honors an explicit scope even for global-only agents', async () => {
      nock('https://example.com').get('/registry.json').reply(200, VALID_REGISTRY_RESPONSE)

      await handlers['hub:install']({agent: 'Hermes', entryId: 'test-entry', scope: 'project'}, 'client-1')

      expect(installService.install.calledOnce).to.be.true
      expect(installService.install.firstCall.args[0].scope).to.equal('project')
    })
  })

  describe('hub:registry:list', () => {
    it('should always include official registry first with status', async () => {
      nock('https://example.com').get('/registry.json').reply(200, VALID_REGISTRY_RESPONSE)

      const result = (await handlers['hub:registry:list']()) as {registries: Array<{authScheme: string; entryCount: number; hasToken: boolean; name: string; status: string; url: string}>}

      expect(result.registries).to.have.lengthOf(1)
      expect(result.registries[0]).to.deep.equal({
        authScheme: 'none',
        entryCount: 1,
        hasToken: false,
        name: 'official',
        status: 'ok',
        url: 'https://example.com/registry.json',
      })
    })

    it('should broadcast progress before checking registries', async () => {
      nock('https://example.com').get('/registry.json').reply(200, VALID_REGISTRY_RESPONSE)

      await handlers['hub:registry:list']()

      expect(transport.broadcast.calledWith('hub:registry:list:progress', {message: 'Checking registries...', step: 'checking'})).to.be.true
    })

    it('should return private registries with token status and authScheme', async () => {
      nock('https://example.com').get('/registry.json').reply(200, VALID_REGISTRY_RESPONSE)
      nock('https://myco.com').get('/registry.json').reply(200, VALID_REGISTRY_RESPONSE)
      hubRegistryConfigStore.getRegistries.resolves([
        {authScheme: 'token', name: 'myco', url: 'https://myco.com/registry.json'},
      ])
      hubKeychainStore.getToken.resolves('secret-token')

      const result = (await handlers['hub:registry:list']()) as {registries: Array<{authScheme: string; entryCount: number; hasToken: boolean; name: string; status: string; url: string}>}

      expect(result.registries).to.have.lengthOf(2)
      expect(result.registries[0].name).to.equal('official')
      expect(result.registries[1]).to.deep.include({
        authScheme: 'token',
        entryCount: 1,
        hasToken: true,
        name: 'myco',
        status: 'ok',
        url: 'https://myco.com/registry.json',
      })
    })

    it('should default authScheme to bearer when not specified', async () => {
      nock('https://example.com').get('/registry.json').reply(200, VALID_REGISTRY_RESPONSE)
      nock('https://myco.com').get('/registry.json').reply(200, VALID_REGISTRY_RESPONSE)
      hubRegistryConfigStore.getRegistries.resolves([
        {name: 'myco', url: 'https://myco.com/registry.json'},
      ])
      hubKeychainStore.getToken.resolves()

      const result = (await handlers['hub:registry:list']()) as {registries: Array<{authScheme: string; name: string}>}

      expect(result.registries[1].authScheme).to.equal('bearer')
    })

    it('should show hasToken as false when no token stored', async () => {
      nock('https://example.com').get('/registry.json').reply(200, VALID_REGISTRY_RESPONSE)
      nock('https://public.com').get('/registry.json').reply(200, VALID_REGISTRY_RESPONSE)
      hubRegistryConfigStore.getRegistries.resolves([
        {name: 'public-reg', url: 'https://public.com/registry.json'},
      ])
      hubKeychainStore.getToken.resolves()

      const result = (await handlers['hub:registry:list']()) as {registries: Array<{hasToken: boolean; name: string; url: string}>}

      expect(result.registries[1].hasToken).to.be.false
    })

    it('should report error status for unreachable registry', async () => {
      nock('https://example.com').get('/registry.json').reply(200, VALID_REGISTRY_RESPONSE)
      nock('https://broken.com').get('/registry.json').replyWithError('getaddrinfo ENOTFOUND broken.com')
      hubRegistryConfigStore.getRegistries.resolves([
        {name: 'broken', url: 'https://broken.com/registry.json'},
      ])
      hubKeychainStore.getToken.resolves()

      const result = (await handlers['hub:registry:list']()) as {registries: Array<{entryCount: number; error?: string; name: string; status: string}>}

      expect(result.registries).to.have.lengthOf(2)
      expect(result.registries[0].status).to.equal('ok')
      expect(result.registries[1]).to.deep.include({
        entryCount: 0,
        name: 'broken',
        status: 'error',
      })
      expect(result.registries[1].error).to.include('Unable to reach')
    })
  })

  describe('hub:registry:add', () => {
    it('should add a registry after validating the URL', async () => {
      nock('https://myco.com').get('/registry.json').reply(200, VALID_REGISTRY_RESPONSE)

      const result = (await handlers['hub:registry:add']({
        name: 'myco',
        url: 'https://myco.com/registry.json',
      }, 'client-1')) as {message: string; success: boolean}

      expect(result.success).to.be.true
      expect(result.message).to.include('myco')
      expect(hubRegistryConfigStore.addRegistry.calledOnce).to.be.true
    })

    it('should broadcast progress during validation and saving', async () => {
      nock('https://myco.com').get('/registry.json').reply(200, VALID_REGISTRY_RESPONSE)

      await handlers['hub:registry:add']({
        name: 'myco',
        url: 'https://myco.com/registry.json',
      }, 'client-1')

      expect(transport.broadcast.calledWith('hub:registry:add:progress', {message: 'Validating registry...', step: 'validating'})).to.be.true
      expect(transport.broadcast.calledWith('hub:registry:add:progress', {message: 'Saving registry...', step: 'saving'})).to.be.true
    })

    it('should store token when provided', async () => {
      nock('https://myco.com').get('/registry.json').reply(200, VALID_REGISTRY_RESPONSE)

      await handlers['hub:registry:add']({
        name: 'myco',
        token: 'my-token',
        url: 'https://myco.com/registry.json',
      }, 'client-1')

      expect(hubKeychainStore.setToken.calledWith('myco', 'my-token')).to.be.true
    })

    it('should persist authScheme and headerName when provided', async () => {
      nock('https://gitlab.com').get('/registry.json').reply(200, VALID_REGISTRY_RESPONSE)

      await handlers['hub:registry:add']({
        authScheme: 'custom-header',
        headerName: 'PRIVATE-TOKEN',
        name: 'gitlab',
        token: 'glpat-xxx',
        url: 'https://gitlab.com/registry.json',
      }, 'client-1')

      const addCall = hubRegistryConfigStore.addRegistry.firstCall.args[0] as {authScheme?: string; headerName?: string; name: string; url: string}
      expect(addCall.authScheme).to.equal('custom-header')
      expect(addCall.headerName).to.equal('PRIVATE-TOKEN')
    })

    it('should not store token when not provided', async () => {
      nock('https://myco.com').get('/registry.json').reply(200, VALID_REGISTRY_RESPONSE)

      await handlers['hub:registry:add']({
        name: 'myco',
        url: 'https://myco.com/registry.json',
      }, 'client-1')

      expect(hubKeychainStore.setToken.called).to.be.false
    })

    it('should reject reserved name "official"', async () => {
      const result = (await handlers['hub:registry:add']({
        name: 'official',
        url: 'https://example.com/registry.json',
      }, 'client-1')) as {message: string; success: boolean}

      expect(result.success).to.be.false
      expect(result.message).to.include('reserved')
    })

    it('should reject reserved names case-insensitively', async () => {
      const names = ['byterover', 'ByteRover', 'brv', 'BRV', 'campfire', 'campfirein']
      const results = await Promise.all(
        names.map((name) =>
          handlers['hub:registry:add']({
            name,
            url: 'https://example.com/registry.json',
          }, 'client-1') as Promise<{message: string; success: boolean}>,
        ),
      )

      for (const result of results) {
        expect(result.success).to.be.false
        expect(result.message).to.include('reserved')
      }
    })

    it('should return error on duplicate name', async () => {
      nock('https://myco.com').get('/registry.json').reply(200, VALID_REGISTRY_RESPONSE)
      hubRegistryConfigStore.addRegistry.rejects(new Error("Registry 'myco' already exists"))

      const result = (await handlers['hub:registry:add']({
        name: 'myco',
        url: 'https://myco.com/registry.json',
      }, 'client-1')) as {message: string; success: boolean}

      expect(result.success).to.be.false
      expect(result.message).to.include('already exists')
    })

    it('should fail when registry URL is unreachable', async () => {
      nock('https://unreachable.com').get('/registry.json').replyWithError('getaddrinfo ENOTFOUND unreachable.com')

      const result = (await handlers['hub:registry:add']({
        name: 'bad-reg',
        url: 'https://unreachable.com/registry.json',
      }, 'client-1')) as {message: string; success: boolean}

      expect(result.success).to.be.false
      expect(result.message).to.include('Unable to reach')
      expect(hubRegistryConfigStore.addRegistry.called).to.be.false
    })

    it('should fail when registry returns invalid data', async () => {
      nock('https://myco.com').get('/registry.json').reply(200, {invalid: true})

      const result = (await handlers['hub:registry:add']({
        name: 'myco',
        url: 'https://myco.com/registry.json',
      }, 'client-1')) as {message: string; success: boolean}

      expect(result.success).to.be.false
      expect(result.message).to.include('invalid data')
      expect(hubRegistryConfigStore.addRegistry.called).to.be.false
    })

    it('should fail when registry returns 401', async () => {
      nock('https://private.com').get('/registry.json').reply(401)

      const result = (await handlers['hub:registry:add']({
        name: 'private-reg',
        token: 'wrong-token',
        url: 'https://private.com/registry.json',
      }, 'client-1')) as {message: string; success: boolean}

      expect(result.success).to.be.false
      expect(result.message).to.include('authentication failed')
      expect(hubRegistryConfigStore.addRegistry.called).to.be.false
    })

    it('should fail when registry request times out', async () => {
      nock('https://slow.com').get('/registry.json').delayConnection(200).reply(200, VALID_REGISTRY_RESPONSE)

      const result = (await handlers['hub:registry:add']({
        name: 'slow-reg',
        url: 'https://slow.com/registry.json',
      }, 'client-1')) as {message: string; success: boolean}

      expect(result.success).to.be.false
      expect(result.message).to.include('timed out')
      expect(hubRegistryConfigStore.addRegistry.called).to.be.false
    })

    it('should not persist config when validation fails', async () => {
      nock('https://bad.com').get('/registry.json').reply(500)

      await handlers['hub:registry:add']({
        name: 'bad-reg',
        url: 'https://bad.com/registry.json',
      }, 'client-1')

      expect(hubRegistryConfigStore.addRegistry.called).to.be.false
      expect(hubKeychainStore.setToken.called).to.be.false
    })
  })

  describe('hub:registry:remove', () => {
    it('should remove a registry and its token', async () => {
      const result = (await handlers['hub:registry:remove']({name: 'myco'}, 'client-1')) as {message: string; success: boolean}

      expect(result.success).to.be.true
      expect(hubRegistryConfigStore.removeRegistry.calledWith('myco')).to.be.true
      expect(hubKeychainStore.deleteToken.calledWith('myco')).to.be.true
    })

    it('should return success message', async () => {
      const result = (await handlers['hub:registry:remove']({name: 'myco'}, 'client-1')) as {message: string; success: boolean}

      expect(result.message).to.include('myco')
      expect(result.message).to.include('removed')
    })
  })
})

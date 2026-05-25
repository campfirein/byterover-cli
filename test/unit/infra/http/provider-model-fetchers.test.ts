import axios from 'axios'
import {expect} from 'chai'
import {restore, type SinonStub, stub} from 'sinon'

import type {ProviderModelInfo} from '../../../../src/server/core/interfaces/i-provider-model-fetcher.js'
import type {ModelsDevClient} from '../../../../src/server/infra/http/models-dev-client.js'

import {ChatBasedModelFetcher, CODEX_FALLBACK_MODELS, OpenAICompatibleModelFetcher, OpenAIModelFetcher} from '../../../../src/server/infra/http/provider-model-fetchers.js'

function makeAxiosErr(status: number): Error {
  const err = new Error(`HTTP ${status}`)
  Object.assign(err, {
    isAxiosError: true,
    response: {data: {}, status, statusText: ''},
  })
  return err
}

function createMockModelsDevClient(models: ProviderModelInfo[] = []): ModelsDevClient {
  return {
    getModelsForProvider: stub().resolves(models),
    refresh: stub().resolves(),
  } as unknown as ModelsDevClient
}

const SAMPLE_OPENAI_MODELS: ProviderModelInfo[] = [
  {
    contextLength: 400_000,
    id: 'gpt-5.3-codex',
    isFree: false,
    name: 'GPT-5.3 Codex',
    pricing: {inputPerM: 1.75, outputPerM: 14},
    provider: 'OpenAI',
  },
  {
    contextLength: 200_000,
    id: 'codex-mini-latest',
    isFree: false,
    name: 'Codex Mini (Latest)',
    pricing: {inputPerM: 1.5, outputPerM: 6},
    provider: 'OpenAI',
  },
  {
    contextLength: 200_000,
    id: 'gpt-5.3-codex-spark',
    isFree: false,
    name: 'GPT-5.3 Codex Spark',
    pricing: {inputPerM: 0.5, outputPerM: 2},
    provider: 'OpenAI',
  },
  {
    contextLength: 128_000,
    id: 'gpt-4o',
    isFree: false,
    name: 'GPT-4o',
    pricing: {inputPerM: 2.5, outputPerM: 10},
    provider: 'OpenAI',
  },
  {
    contextLength: 200_000,
    id: 'gpt-5.2',
    isFree: false,
    name: 'GPT-5.2',
    pricing: {inputPerM: 1.75, outputPerM: 14},
    provider: 'OpenAI',
  },
  {
    contextLength: 128_000,
    id: 'gpt-4.1',
    isFree: false,
    name: 'GPT-4.1',
    pricing: {inputPerM: 2, outputPerM: 8},
    provider: 'OpenAI',
  },
]

describe('OpenAIModelFetcher', () => {
  describe('fetchModels with OAuth (models.dev)', () => {
    it('should fetch from models.dev and filter to Codex-allowed models', async () => {
      const mockClient = createMockModelsDevClient(SAMPLE_OPENAI_MODELS)
      const fetcher = new OpenAIModelFetcher({modelsDevClient: mockClient})
      const models = await fetcher.fetchModels('token', {authMethod: 'oauth'})

      const ids = models.map((m) => m.id)
      // Should include only models in the strict allowlist
      expect(ids).to.include('gpt-5.3-codex')
      expect(ids).to.include('gpt-5.2')
      // Should NOT include models with "codex" in name but not in allowlist
      expect(ids).to.not.include('codex-mini-latest')
      expect(ids).to.not.include('gpt-5.3-codex-spark')
      // Should NOT include non-allowlist models
      expect(ids).to.not.include('gpt-4o')
      expect(ids).to.not.include('gpt-4.1')
    })

    it('should zero out costs for all OAuth models (included in subscription)', async () => {
      const mockClient = createMockModelsDevClient(SAMPLE_OPENAI_MODELS)
      const fetcher = new OpenAIModelFetcher({modelsDevClient: mockClient})
      const models = await fetcher.fetchModels('token', {authMethod: 'oauth'})

      for (const model of models) {
        expect(model.isFree).to.be.false
        expect(model.pricing.inputPerM).to.equal(0)
        expect(model.pricing.outputPerM).to.equal(0)
      }
    })

    it('should preserve context length from models.dev', async () => {
      const mockClient = createMockModelsDevClient(SAMPLE_OPENAI_MODELS)
      const fetcher = new OpenAIModelFetcher({modelsDevClient: mockClient})
      const models = await fetcher.fetchModels('token', {authMethod: 'oauth'})

      const codex = models.find((m) => m.id === 'gpt-5.3-codex')
      expect(codex?.contextLength).to.equal(400_000)
    })

    it('should fall back to CODEX_FALLBACK_MODELS when models.dev returns empty', async () => {
      const mockClient = createMockModelsDevClient([])
      const fetcher = new OpenAIModelFetcher({modelsDevClient: mockClient})
      const models = await fetcher.fetchModels('token', {authMethod: 'oauth'})

      expect(models).to.deep.equal([...CODEX_FALLBACK_MODELS])
    })

    it('should fall back when no models match the allowlist', async () => {
      const nonCodexModels: ProviderModelInfo[] = [
        {
          contextLength: 128_000,
          id: 'gpt-4o',
          isFree: false,
          name: 'GPT-4o',
          pricing: {inputPerM: 2.5, outputPerM: 10},
          provider: 'OpenAI',
        },
      ]
      const mockClient = createMockModelsDevClient(nonCodexModels)
      const fetcher = new OpenAIModelFetcher({modelsDevClient: mockClient})
      const models = await fetcher.fetchModels('token', {authMethod: 'oauth'})

      expect(models).to.deep.equal([...CODEX_FALLBACK_MODELS])
    })

    it('should call getModelsForProvider with openai provider ID', async () => {
      const mockClient = createMockModelsDevClient(SAMPLE_OPENAI_MODELS)
      const fetcher = new OpenAIModelFetcher({modelsDevClient: mockClient})
      await fetcher.fetchModels('token', {authMethod: 'oauth'})

      expect((mockClient.getModelsForProvider as SinonStub).calledWith('openai')).to.be.true
    })

    it('should pass forceRefresh to models.dev client', async () => {
      const mockClient = createMockModelsDevClient(SAMPLE_OPENAI_MODELS)
      const fetcher = new OpenAIModelFetcher({modelsDevClient: mockClient})
      await fetcher.fetchModels('token', {authMethod: 'oauth', forceRefresh: true})

      expect((mockClient.getModelsForProvider as SinonStub).calledWith('openai', true)).to.be.true
    })
  })

  describe('ChatBasedModelFetcher.validateApiKey (ENG-2609)', () => {
    // Stubs `axios.post` directly so we can simulate per-call responses across
    // the model-iteration loop. Mirrors the GLM Coding Plan failure where
    // glm-4.7 isn't on the coding-plan tier but glm-4.5 is.

    afterEach(() => {
      restore()
    })

    it('returns isValid:true on the first model that succeeds', async () => {
      const post = stub(axios, 'post').resolves({data: {}, status: 200})
      const fetcher = new ChatBasedModelFetcher('https://api.example.com/v1', 'X', ['model-a', 'model-b'])

      const result = await fetcher.validateApiKey('sk-good')
      expect(result).to.deep.equal({isValid: true})
      expect(post.callCount).to.equal(1)
    })

    it('skips a 400 model-not-found and retries with the next model', async () => {
      const post = stub(axios, 'post')
      post.onFirstCall().rejects(makeAxiosErr(400))
      post.onSecondCall().resolves({data: {}, status: 200})
      const fetcher = new ChatBasedModelFetcher('https://api.z.ai/api/coding/paas/v4', 'GLM Coding Plan', ['glm-4.7', 'glm-4.5'])

      const result = await fetcher.validateApiKey('sk-good')
      expect(result).to.deep.equal({isValid: true})
      expect(post.callCount).to.equal(2)
    })

    it('skips 404 model-not-found and retries', async () => {
      const post = stub(axios, 'post')
      post.onFirstCall().rejects(makeAxiosErr(404))
      post.onSecondCall().resolves({data: {}, status: 200})
      const fetcher = new ChatBasedModelFetcher('https://api.example.com/v1', 'X', ['a', 'b'])

      const result = await fetcher.validateApiKey('sk-good')
      expect(result.isValid).to.equal(true)
      expect(post.callCount).to.equal(2)
    })

    it('returns isValid:false on 401 even if later models would have worked', async () => {
      const post = stub(axios, 'post').rejects(makeAxiosErr(401))
      const fetcher = new ChatBasedModelFetcher('https://api.example.com/v1', 'X', ['a', 'b'])

      const result = await fetcher.validateApiKey('sk-bad')
      expect(result.error).to.equal('Invalid API key')
      expect(result.isValid).to.equal(false)
      expect(post.callCount).to.equal(1) // short-circuits, doesn't try b
    })

    it('returns isValid:false on 403', async () => {
      stub(axios, 'post').rejects(makeAxiosErr(403))
      const fetcher = new ChatBasedModelFetcher('https://api.example.com/v1', 'X', ['a'])

      const result = await fetcher.validateApiKey('sk-no-perm')
      expect(result.error).to.equal('API key does not have required permissions')
      expect(result.isValid).to.equal(false)
    })

    it('treats 429 (rate limit) as key-accepted', async () => {
      stub(axios, 'post').rejects(makeAxiosErr(429))
      const fetcher = new ChatBasedModelFetcher('https://api.example.com/v1', 'X', ['a'])

      const result = await fetcher.validateApiKey('sk-rate-limited')
      expect(result).to.deep.equal({isValid: true})
    })

    it('treats 5xx as key-accepted (server-side issue, not auth)', async () => {
      stub(axios, 'post').rejects(makeAxiosErr(503))
      const fetcher = new ChatBasedModelFetcher('https://api.example.com/v1', 'X', ['a'])

      const result = await fetcher.validateApiKey('sk-good')
      expect(result.isValid).to.equal(true)
    })

    it('returns isValid:false with last error if all models 400/404', async () => {
      const post = stub(axios, 'post')
      post.onFirstCall().rejects(makeAxiosErr(400))
      post.onSecondCall().rejects(makeAxiosErr(404))
      const fetcher = new ChatBasedModelFetcher('https://api.example.com/v1', 'X', ['a', 'b'])

      const result = await fetcher.validateApiKey('sk-???')
      expect(result.isValid).to.equal(false)
      expect(post.callCount).to.equal(2)
    })

    it('falls back to default model when knownModels is empty', async () => {
      const post = stub(axios, 'post').resolves({data: {}, status: 200})
      const fetcher = new ChatBasedModelFetcher('https://api.example.com/v1', 'X', [])

      const result = await fetcher.validateApiKey('sk-good')
      expect(result).to.deep.equal({isValid: true})
      expect(post.calledOnce).to.be.true
      // Should have used 'default' as the fallback model id
      const body = post.firstCall.args[1] as {model: string}
      expect(body.model).to.equal('default')
    })
    })

  describe('OpenAICompatibleModelFetcher.fetchModels dedup', () => {
    afterEach(() => {
      restore()
    })

    it('dedupes by id when upstream returns duplicate entries', async () => {
      stub(axios, 'get').resolves({
        data: {
          data: [
            {id: 'openai/gpt-oss-120b'},
            {id: 'openai/gpt-oss-120b'},
            {id: 'openai/gpt-oss-20b'},
            {id: 'openai/gpt-oss-20b'},
          ],
        },
        status: 200,
      })
      const fetcher = new OpenAICompatibleModelFetcher('https://example.test/v1', 'OpenAI Compatible')

      const models = await fetcher.fetchModels('sk-test')
      const ids = models.map((m) => m.id)

      expect(ids).to.deep.equal(['openai/gpt-oss-120b', 'openai/gpt-oss-20b'])
    })

    it('keeps the first occurrence when ids collide', async () => {
      /* eslint-disable camelcase */
      stub(axios, 'get').resolves({
        data: {
          data: [
            {context_length: 128_000, id: 'mistral-large', name: 'mistral-large'},
            {context_length: 999_999, id: 'mistral-large', name: 'mistral-large'},
          ],
        },
        status: 200,
      })
      /* eslint-enable camelcase */
      const fetcher = new OpenAICompatibleModelFetcher('https://example.test/v1', 'OpenAI Compatible')

      const models = await fetcher.fetchModels('sk-test')

      expect(models).to.have.lengthOf(1)
      expect(models[0].contextLength).to.equal(128_000)
    })

    it('skips entries with neither id nor name', async () => {
      stub(axios, 'get').resolves({
        data: {
          data: [
            {id: 'a-model'},
            {description: 'orphan with no id or name'},
            {id: '', name: ''},
            {id: 'b-model'},
          ],
        },
        status: 200,
      })
      const fetcher = new OpenAICompatibleModelFetcher('https://example.test/v1', 'OpenAI Compatible')

      const models = await fetcher.fetchModels('sk-test')

      expect(models.map((m) => m.id)).to.deep.equal(['a-model', 'b-model'])
    })

    it('passes through unique ids unchanged', async () => {
      stub(axios, 'get').resolves({
        data: {
          data: [
            {id: 'b-model'},
            {id: 'a-model'},
            {id: 'c-model'},
          ],
        },
        status: 200,
      })
      const fetcher = new OpenAICompatibleModelFetcher('https://example.test/v1', 'OpenAI Compatible')

      const models = await fetcher.fetchModels('sk-test')

      expect(models.map((m) => m.id)).to.deep.equal(['a-model', 'b-model', 'c-model'])
    })
  })
})

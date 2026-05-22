/**
 * Regression test for ENG-2897: every provider module declaring
 * `providerType: 'openai'` (i.e. uses an OpenAI-compatible API) must resolve
 * to the `'openai'` registry type via `resolveRegistryProvider`.
 *
 * A missing entry routes the provider through Gemini formatter/tokenizer/
 * registry, fires the "Model X not supported for provider 'gemini'" warning,
 * and corrupts context-length lookups. This test cross-checks the resolver's
 * hardcoded list (in domain) against the actual provider modules (in infra)
 * so any new OpenAI-compatible provider added in infra without updating the
 * resolver fails this test instead of silently misrouting users.
 */
import {expect} from 'chai'

import {resolveRegistryProvider} from '../../../../../../src/agent/core/domain/llm/registry.js'
import {listProviderModules} from '../../../../../../src/agent/infra/llm/providers/index.js'

describe('resolveRegistryProvider', () => {
  it("returns 'claude' for the anthropic user-facing ID", () => {
    expect(resolveRegistryProvider('any-model', 'anthropic')).to.equal('claude')
  })

  it("returns 'gemini' for the google user-facing IDs", () => {
    expect(resolveRegistryProvider('any-model', 'google')).to.equal('gemini')
    expect(resolveRegistryProvider('any-model', 'google-vertex')).to.equal('gemini')
  })

  describe('OpenAI-compatible passthrough providers', () => {
    // Cross-checks the resolver's hardcoded list against every provider module
    // in infra that declares `providerType: 'openai'`. Adding a new
    // OpenAI-compatible provider module without updating the resolver will
    // fail this test, preventing the misrouting bug from regressing.
    const openaiCompatibleIds = listProviderModules()
      .filter((m) => m.providerType === 'openai')
      .map((m) => m.id)

    for (const providerId of openaiCompatibleIds) {
      it(`resolves '${providerId}' to 'openai'`, () => {
        expect(resolveRegistryProvider('arbitrary-passthrough-model', providerId)).to.equal('openai')
      })
    }

    it('covers every infra provider module with providerType=openai', () => {
      // Sanity floor: catches the case where listProviderModules() returns
      // an empty/filtered-empty list and the per-id tests above silently no-op.
      expect(openaiCompatibleIds.length).to.be.greaterThan(0)
      expect(openaiCompatibleIds).to.include('openai-compatible')
    })
  })

  describe('fallback to model-name prefix', () => {
    it("infers 'claude' from claude-* model names without explicit provider", () => {
      expect(resolveRegistryProvider('claude-sonnet-4-6')).to.equal('claude')
    })

    it("infers 'openai' from gpt-* model names without explicit provider", () => {
      expect(resolveRegistryProvider('gpt-4.1')).to.equal('openai')
      expect(resolveRegistryProvider('o3-mini')).to.equal('openai')
    })
  })
})

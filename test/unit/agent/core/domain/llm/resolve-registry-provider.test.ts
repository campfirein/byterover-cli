/**
 * Regression test for ENG-2897: every provider module declared in
 * `src/agent/infra/llm/providers/` must resolve to its declared
 * `providerType` via `resolveRegistryProvider`.
 *
 * A missing or wrong entry routes the provider through the wrong formatter/
 * tokenizer/registry, fires the "Model X not supported for provider 'Y'"
 * warning, and corrupts context-length lookups. This test cross-checks the
 * resolver's hardcoded lists (in domain) against the actual provider modules
 * (in infra) so any new provider added in infra without updating the
 * resolver fails this test instead of silently misrouting users.
 *
 * The cross-check fires for every `providerType` bucket — `'claude'`,
 * `'gemini'`, AND `'openai'` — rather than only openai. This catches drift
 * on the gemini/claude side too (e.g. the latent `byterover` case before
 * this PR, which worked only because of the terminal `return 'gemini'`
 * default, not because of explicit mapping).
 */
import {expect} from 'chai'

import {resolveRegistryProvider} from '../../../../../../src/agent/core/domain/llm/registry.js'
import {listProviderModules} from '../../../../../../src/agent/infra/llm/providers/index.js'

describe('resolveRegistryProvider', () => {
  describe('every infra provider module resolves to its declared providerType', () => {
    const modules = listProviderModules()

    for (const module of modules) {
      it(`'${module.id}' (declared providerType=${module.providerType}) resolves to '${module.providerType}'`, () => {
        expect(resolveRegistryProvider('arbitrary-passthrough-model', module.id)).to.equal(module.providerType)
      })
    }

    it('covers every infra provider module across all providerType buckets', () => {
      // Sanity floor: catches the case where listProviderModules() returns
      // an empty list and the per-module tests above silently no-op.
      // Also asserts coverage of each providerType bucket so a regression on
      // any one (claude / gemini / openai) lights up here.
      expect(modules.length).to.be.greaterThan(0)
      expect(modules.map((m) => m.id)).to.include('openai-compatible')
      const buckets = new Set(modules.map((m) => m.providerType))
      expect(buckets).to.include('claude')
      expect(buckets).to.include('gemini')
      expect(buckets).to.include('openai')
    })
  })

  describe('user-facing IDs without an infra module', () => {
    // `google-vertex` is exposed in PROVIDER_REGISTRY (user-facing) but has
    // no agent-side ProviderModule, so the cross-check above does not cover
    // it. Pin the resolver's special-case mapping here.
    it("'google-vertex' resolves to 'gemini'", () => {
      expect(resolveRegistryProvider('any-model', 'google-vertex')).to.equal('gemini')
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

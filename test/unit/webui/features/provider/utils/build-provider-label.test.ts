import {expect} from 'chai'

import type {ProviderDTO} from '../../../../../../src/shared/transport/types/dto'

import {buildProviderLabel} from '../../../../../../src/webui/features/provider/utils/build-provider-label'

const provider = (overrides: Partial<ProviderDTO> = {}): ProviderDTO => ({
  category: 'popular',
  description: '',
  id: 'openai',
  isConnected: true,
  isCurrent: true,
  name: 'OpenAI',
  requiresApiKey: true,
  supportsOAuth: false,
  ...overrides,
})

describe('buildProviderLabel', () => {
  it('returns the no-provider fallback when nothing is active', () => {
    expect(buildProviderLabel()).to.equal('No provider configured')
  })

  it('joins provider name and active model with a pipe', () => {
    const p = provider()
    expect(buildProviderLabel(p, {activeModel: 'gpt-4o', activeProviderId: p.id})).to.equal('OpenAI | gpt-4o')
  })

  it('omits the model suffix when no active model is set', () => {
    const p = provider()
    expect(buildProviderLabel(p, {activeProviderId: p.id})).to.equal('OpenAI')
  })

  it('omits the model suffix for the byterover provider even when a model is reported', () => {
    const p = provider({id: 'byterover', name: 'ByteRover'})
    expect(
      buildProviderLabel(p, {activeModel: 'gemini-3-flash-preview', activeProviderId: p.id}),
    ).to.equal('ByteRover')
  })
})

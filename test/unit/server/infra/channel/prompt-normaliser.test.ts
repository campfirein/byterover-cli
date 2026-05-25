import {expect} from 'chai'

import {ChannelPromptEmptyError} from '../../../../../src/server/core/domain/channel/errors.js'
import {normalisePrompt} from '../../../../../src/server/infra/channel/prompt-normaliser.js'

// Slice 2.3 — §8.4 prompt precedence + emptiness rules.
//
// Verbatim from CHANNEL_PROTOCOL.md §8.4:
//   - prompt only → [{ type: 'text', text: prompt }]
//   - promptBlocks only → promptBlocks unchanged
//   - both → [...promptBlocks, { type: 'text', text: prompt }]
//   - prompt-empty after normalisation → CHANNEL_PROMPT_EMPTY
// Structured-only prompts (resource_link with no text) are valid;
// text-only-whitespace prompts are empty.

describe('normalisePrompt', () => {
  it('prompt only → single text block', () => {
    expect(normalisePrompt({prompt: 'hi'})).to.deep.equal([{text: 'hi', type: 'text'}])
  })

  it('promptBlocks only → blocks unchanged', () => {
    const blocks = [{text: 'a', type: 'text'} as const, {type: 'resource_link', uri: 'file:///a'} as const]
    expect(normalisePrompt({promptBlocks: [...blocks]})).to.deep.equal(blocks)
  })

  it('both → blocks then a trailing text block carrying the prompt string', () => {
    const blocks = [{type: 'resource_link', uri: 'file:///a'} as const]
    expect(normalisePrompt({prompt: 'tail', promptBlocks: [...blocks]})).to.deep.equal([
      ...blocks,
      {text: 'tail', type: 'text'},
    ])
  })

  it('throws CHANNEL_PROMPT_EMPTY when both fields are absent', () => {
    expect(() => normalisePrompt({})).to.throw(ChannelPromptEmptyError)
  })

  it('throws CHANNEL_PROMPT_EMPTY when prompt is whitespace and promptBlocks is missing', () => {
    expect(() => normalisePrompt({prompt: '   '})).to.throw(ChannelPromptEmptyError)
  })

  it('throws CHANNEL_PROMPT_EMPTY when promptBlocks contains only whitespace text', () => {
    expect(() =>
      normalisePrompt({promptBlocks: [{text: '   ', type: 'text'}]}),
    ).to.throw(ChannelPromptEmptyError)
  })

  it('accepts a structured-only prompt (resource_link with no text)', () => {
    expect(normalisePrompt({promptBlocks: [{type: 'resource_link', uri: 'file:///a'}]})).to.deep.equal([
      {type: 'resource_link', uri: 'file:///a'},
    ])
  })

  it('accepts prompt-only when promptBlocks is an empty array', () => {
    expect(normalisePrompt({prompt: 'hi', promptBlocks: []})).to.deep.equal([{text: 'hi', type: 'text'}])
  })
})

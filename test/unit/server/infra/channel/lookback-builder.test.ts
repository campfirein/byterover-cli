import {expect} from 'chai'

import type {ContentBlock, Turn} from '../../../../../src/shared/types/channel.js'

import {buildLookback} from '../../../../../src/server/infra/channel/lookback-builder.js'

// Slice 2.3 — capability-gated lookback per CHANNEL_PROTOCOL.md §5.2 and
// IMPLEMENTATION_PHASE_2.md §Slice 2.3 §4. Slice 9.3 — priorTurns are
// pulled from the per-channel index, so rendering reads from
// `turn.promptBlocks` directly (no events replay; zero per-turn NDJSON
// opens on the lookback hot path).
//
// Inputs: { channelId, capabilities, normalisedPromptBlocks, priorTurns }
// Outputs: { blocks, digest, summary }
//
// Rules:
//   - empty priorTurns → only normalisedPromptBlocks; no lookback block
//   - capabilities.embeddedContext === true → prepend a `resource` block
//   - baseline → prepend a `text` block with `## brv channel lookback`
//   - digest is sha256 hex of the rendered lookback bytes; empty when no block

const fakeTurn = (turnId: string, content: string): Turn => ({
  author: {handle: 'you', kind: 'local-user'},
  channelId: 'pi-test',
  mentions: [],
  promptBlocks: [{text: content, type: 'text'}],
  promptedBy: 'user',
  startedAt: '2026-05-11T00:00:00.000Z',
  state: 'completed',
  turnId,
})

const userPromptBlocks: ContentBlock[] = [{text: '@mock hello', type: 'text'}]

describe('buildLookback', () => {
  it('returns only user blocks (no lookback prefix) when there are no prior turns', () => {
    const result = buildLookback({
      capabilities: [],
      channelId: 'pi-test',
      normalisedPromptBlocks: userPromptBlocks,
      priorTurns: [],
    })
    expect(result.blocks).to.deep.equal(userPromptBlocks)
    expect(result.digest).to.equal('')
  })

  it('baseline (no embeddedContext): prepends a `text` block with `## brv channel lookback`', () => {
    const result = buildLookback({
      capabilities: [],
      channelId: 'pi-test',
      normalisedPromptBlocks: userPromptBlocks,
      priorTurns: [fakeTurn('t-1', 'previous message')],
    })
    expect(result.blocks.length).to.equal(2)
    const lookback = result.blocks[0]
    expect(lookback.type).to.equal('text')
    if (lookback.type !== 'text') throw new Error('unreachable')
    expect(lookback.text).to.match(/## brv channel lookback/)
    expect(lookback.text).to.match(/previous message/)
    expect(result.blocks[1]).to.deep.equal({text: '@mock hello', type: 'text'})
    expect(result.digest).to.match(/^[0-9a-f]+$/)
  })

  it('embeddedContext=true: prepends a `resource` block carrying the rendered transcript', () => {
    const result = buildLookback({
      capabilities: ['embeddedContext'],
      channelId: 'pi-test',
      normalisedPromptBlocks: userPromptBlocks,
      priorTurns: [fakeTurn('t-1', 'previous message')],
    })
    const lookback = result.blocks[0]
    expect(lookback.type).to.equal('resource')
    if (lookback.type !== 'resource') throw new Error('unreachable')
    expect((lookback.resource as {mimeType?: string}).mimeType).to.equal('text/markdown')
    expect((lookback.resource as {uri?: string}).uri).to.equal('brv-channel://pi-test/lookback')
    expect((lookback.resource as {text?: string}).text).to.match(/previous message/)
    expect(result.digest).to.match(/^[0-9a-f]+$/)
  })

  it('preserves the user prompt blocks verbatim as the trailing blocks (no synthesis)', () => {
    const structuredBlocks: ContentBlock[] = [{type: 'resource_link', uri: 'file:///a.md'}]
    const result = buildLookback({
      capabilities: [],
      channelId: 'pi-test',
      normalisedPromptBlocks: structuredBlocks,
      priorTurns: [fakeTurn('t-1', 'context')],
    })
    expect(result.blocks.length).to.equal(2)
    expect(result.blocks.at(-1)).to.deep.equal({type: 'resource_link', uri: 'file:///a.md'})
  })
})

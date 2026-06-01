import {expect} from 'chai'

import {projectSessionUpdate} from '../../../../../../src/server/infra/channel/drivers/acp-event-projector.js'

// Projects an ACP `session/update` payload into a payload-only TurnEvent slice
// (the orchestrator stamps channelId/turnId/deliveryId/memberHandle/emittedAt/seq
// before persisting). Reconciled to the M0 TurnEvent union: only the three kinds
// the union models are projected; every other session-update kind is dropped
// (returns undefined) rather than crashing the driver.

describe('acp-event-projector (projectSessionUpdate)', () => {
  describe('mapped kinds', () => {
    it('projects agent_message_chunk → { kind, content }', () => {
      const event = projectSessionUpdate({
        content: {text: 'hello', type: 'text'},
        sessionUpdate: 'agent_message_chunk',
      })
      expect(event).to.deep.equal({content: 'hello', kind: 'agent_message_chunk'})
    })

    it('projects agent_thought_chunk → { kind, content }', () => {
      const event = projectSessionUpdate({
        content: {text: 'thinking…', type: 'text'},
        sessionUpdate: 'agent_thought_chunk',
      })
      expect(event).to.deep.equal({content: 'thinking…', kind: 'agent_thought_chunk'})
    })

    it('projects tool_call → { kind, toolCallId, name, input } from rawInput + title', () => {
      const event = projectSessionUpdate({
        rawInput: {cmd: 'ls'},
        sessionUpdate: 'tool_call',
        title: 'List dir',
        toolCallId: 'tc-1',
      })
      expect(event).to.deep.equal({
        input: {cmd: 'ls'},
        kind: 'tool_call',
        name: 'List dir',
        toolCallId: 'tc-1',
      })
    })

    it('synthesises tool_call input from content[] when rawInput is absent', () => {
      const event = projectSessionUpdate({
        content: [{text: 'partial output', type: 'text'}],
        sessionUpdate: 'tool_call',
        title: 'Run',
        toolCallId: 'tc-2',
      })
      expect(event).to.deep.equal({
        input: 'partial output',
        kind: 'tool_call',
        name: 'Run',
        toolCallId: 'tc-2',
      })
    })

    it('projects tool_call_update → { kind, toolCallId, status?, output? } from rawOutput', () => {
      const event = projectSessionUpdate({
        rawOutput: 'a\nb',
        sessionUpdate: 'tool_call_update',
        status: 'completed',
        toolCallId: 'tc-1',
      })
      expect(event).to.deep.equal({
        kind: 'tool_call_update',
        output: 'a\nb',
        status: 'completed',
        toolCallId: 'tc-1',
      })
    })

    it('synthesises tool_call_update output from content[] when rawOutput is absent', () => {
      const event = projectSessionUpdate({
        content: [{text: 'partial', type: 'text'}],
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-2',
      })
      expect(event).to.deep.equal({kind: 'tool_call_update', output: 'partial', toolCallId: 'tc-2'})
    })

    it('includes error on tool_call_update when present', () => {
      const event = projectSessionUpdate({
        error: 'boom',
        sessionUpdate: 'tool_call_update',
        status: 'failed',
        toolCallId: 'tc-3',
      })
      expect(event).to.deep.equal({
        error: 'boom',
        kind: 'tool_call_update',
        status: 'failed',
        toolCallId: 'tc-3',
      })
    })

    it('defaults missing content to an empty string (does not throw)', () => {
      const event = projectSessionUpdate({sessionUpdate: 'agent_message_chunk'})
      expect(event).to.deep.equal({content: '', kind: 'agent_message_chunk'})
    })
  })

  describe('kinds absent from the TurnEvent union → dropped', () => {
    it('drops plan → undefined', () => {
      const event = projectSessionUpdate({
        entries: [{content: 'step 1', priority: 'high', status: 'pending'}],
        sessionUpdate: 'plan',
      })
      expect(event).to.equal(undefined)
    })

    it('drops current_model_update (agent_meta family) → undefined', () => {
      const event = projectSessionUpdate({
        modelId: 'kimi-k2',
        sessionUpdate: 'current_model_update',
      })
      expect(event).to.equal(undefined)
    })
  })

  describe('unknown kinds', () => {
    it('drops an unrecognised sessionUpdate → undefined (does not throw)', () => {
      const event = projectSessionUpdate({
        sessionUpdate: 'totally_unknown_kind',
        whatever: 1,
      })
      expect(event).to.equal(undefined)
    })
  })

  describe('malformed input → dropped (does not throw)', () => {
    it('returns undefined for undefined', () => {
      // eslint-disable-next-line unicorn/no-useless-undefined -- passing undefined is the case under test
      expect(projectSessionUpdate(undefined)).to.equal(undefined)
    })

    it('returns undefined for null', () => {
      expect(projectSessionUpdate(null)).to.equal(undefined)
    })

    it('returns undefined for a non-object', () => {
      expect(projectSessionUpdate('nope')).to.equal(undefined)
    })

    it('returns undefined when sessionUpdate is missing', () => {
      expect(projectSessionUpdate({content: {text: 'x', type: 'text'}})).to.equal(undefined)
    })

    it('returns undefined when sessionUpdate is not a string', () => {
      expect(projectSessionUpdate({sessionUpdate: 123})).to.equal(undefined)
    })
  })
})

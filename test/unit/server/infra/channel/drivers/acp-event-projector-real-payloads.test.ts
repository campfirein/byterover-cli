import {expect} from 'chai'

import {projectSessionUpdate} from '../../../../../../src/server/infra/channel/drivers/acp-event-projector.js'

// Slice 4.3 — projector tolerance for the real `kimi acp` session/update
// shapes. The Phase-3 projector handled five kinds; real kimi emits
// available_commands_update, current_mode_update, current_model_update,
// rich content[] arrays, and statuses outside the closed enum. This slice
// widens the projector to surface those events instead of dropping them.

describe('projectSessionUpdate — Slice 4.3 widening', () => {
  describe('agent_meta projections (forward-compat)', () => {
    it('projects available_commands_update → agent_meta with subKind + payload', () => {
      const payload = {
        availableCommands: [{description: 'show help', name: '/help'}],
      }
      const event = projectSessionUpdate({sessionUpdate: 'available_commands_update', ...payload})
      expect(event).to.deep.equal({
        kind: 'agent_meta',
        payload,
        subKind: 'available_commands_update',
      })
    })

    it('projects current_mode_update → agent_meta', () => {
      const event = projectSessionUpdate({
        currentModeId: 'default',
        sessionUpdate: 'current_mode_update',
      })
      expect(event).to.deep.equal({
        kind: 'agent_meta',
        payload: {currentModeId: 'default'},
        subKind: 'current_mode_update',
      })
    })

    it('projects current_model_update → agent_meta', () => {
      const event = projectSessionUpdate({
        currentModelId: 'kimi-k2',
        sessionUpdate: 'current_model_update',
      })
      expect(event).to.deep.equal({
        kind: 'agent_meta',
        payload: {currentModelId: 'kimi-k2'},
        subKind: 'current_model_update',
      })
    })
  })

  describe('tool_call_update widening', () => {
    it('accepts arbitrary status strings (no closed enum)', () => {
      const event = projectSessionUpdate({
        sessionUpdate: 'tool_call_update',
        status: 'pending',
        toolCallId: 'tc-99',
      })
      expect(event).to.deep.equal({
        kind: 'tool_call_update',
        status: 'pending',
        toolCallId: 'tc-99',
      })
    })

    it('flattens content[] text blocks into output when rawOutput is absent', () => {
      const event = projectSessionUpdate({
        content: [
          {content: {text: 'hello\n', type: 'text'}, type: 'content'},
          {content: {text: 'world', type: 'text'}, type: 'content'},
        ],
        sessionUpdate: 'tool_call_update',
        status: 'completed',
        toolCallId: 'tc-100',
      })
      expect(event).to.deep.equal({
        kind: 'tool_call_update',
        output: 'hello\nworld',
        status: 'completed',
        toolCallId: 'tc-100',
      })
    })

    it('prefers rawOutput when both rawOutput and content[] are present', () => {
      const event = projectSessionUpdate({
        content: [{content: {text: 'flattened', type: 'text'}, type: 'content'}],
        rawOutput: {value: 42},
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-101',
      })
      expect(event).to.deep.equal({
        kind: 'tool_call_update',
        output: {value: 42},
        toolCallId: 'tc-101',
      })
    })
  })

  describe('tool_call widening', () => {
    it('synthesises a string input from content[] when rawInput is absent', () => {
      const event = projectSessionUpdate({
        content: [
          {content: {text: 'reading ', type: 'text'}, type: 'content'},
          {content: {text: 'plan/pi/DESIGN.md', type: 'text'}, type: 'content'},
        ],
        kind: 'read',
        sessionUpdate: 'tool_call',
        title: 'Read file',
        toolCallId: 'tc-r1',
      })
      expect(event).to.deep.equal({
        input: 'reading plan/pi/DESIGN.md',
        kind: 'tool_call',
        name: 'Read file',
        toolCallId: 'tc-r1',
      })
    })

    it('keeps rawInput when present (regression sentinel — Phase 3 behaviour)', () => {
      const event = projectSessionUpdate({
        rawInput: {path: '/tmp/x'},
        sessionUpdate: 'tool_call',
        title: 'Write',
        toolCallId: 'tc-w1',
      })
      expect(event).to.deep.equal({
        input: {path: '/tmp/x'},
        kind: 'tool_call',
        name: 'Write',
        toolCallId: 'tc-w1',
      })
    })

    it('does not synthesise output on tool_call (the schema variant has no output field)', () => {
      const event = projectSessionUpdate({
        content: [{content: {text: 'will-be-input-not-output', type: 'text'}, type: 'content'}],
        sessionUpdate: 'tool_call',
        title: 'TitleX',
        toolCallId: 'tc-x1',
      })
      expect(event).to.have.property('input')
      expect(event).to.not.have.property('output')
    })
  })

  describe('unknown kinds fallback (preserved)', () => {
    it('still returns undefined for truly unrecognised sessionUpdate kinds', () => {
      expect(projectSessionUpdate({sessionUpdate: 'totally_unknown_kind'} as never)).to.equal(undefined)
    })
  })
})

import {expect} from 'chai'

import {projectSessionUpdate} from '../../../../../../src/server/infra/channel/drivers/acp-event-projector.js'

// Slice 2.2 — projects an ACP `session/update` notification payload into a
// payload-only TurnEvent (the orchestrator wraps it with TurnEventBase fields
// channelId/turnId/deliveryId/memberHandle/emittedAt/seq before persisting).

describe('projectSessionUpdate', () => {
  it('projects agent_message_chunk → { kind: "agent_message_chunk", content }', () => {
    const event = projectSessionUpdate({
      content: {text: 'hello', type: 'text'},
      sessionUpdate: 'agent_message_chunk',
    })
    expect(event).to.deep.equal({content: 'hello', kind: 'agent_message_chunk'})
  })

  it('projects agent_thought_chunk → { kind: "agent_thought_chunk", content }', () => {
    const event = projectSessionUpdate({
      content: {text: 'thinking…', type: 'text'},
      sessionUpdate: 'agent_thought_chunk',
    })
    expect(event).to.deep.equal({content: 'thinking…', kind: 'agent_thought_chunk'})
  })

  it('projects tool_call → { kind: "tool_call", toolCallId, name, input }', () => {
    const event = projectSessionUpdate({
      kind: 'execute',
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

  it('projects tool_call_update → { kind: "tool_call_update", toolCallId, status?, output?, error? }', () => {
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

  it('projects plan → { kind: "plan", entries }', () => {
    const entries = [{content: 'step 1', priority: 'high', status: 'pending'}]
    const event = projectSessionUpdate({entries, sessionUpdate: 'plan'})
    expect(event).to.deep.equal({entries, kind: 'plan'})
  })

  it('returns undefined for unrecognised sessionUpdate kinds (callers WARN-log and drop)', () => {
    expect(projectSessionUpdate({sessionUpdate: 'totally_unknown_kind'} as never)).to.equal(undefined)
  })
})

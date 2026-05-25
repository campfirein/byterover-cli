#!/usr/bin/env node
// mock-ACP fixture: requests user permission before completing the prompt.
//
// Used by `channel-phase2-permission-flow.test.ts`. Sends a
// `session/request_permission` JSON-RPC request, awaits the host's response,
// and only then resolves `session/prompt` with `stopReason: 'end_turn'`. If
// the user denied or cancelled, resolves with `stopReason: 'refusal'` /
// `'cancelled'` so the integration test can assert on terminal delivery
// state.

import {start} from './mock-acp-lib.js'

start({
  async handlePrompt(params, ctx) {
    const {sessionId} = params
    ctx.sendNotification('session/update', {
      sessionId,
      update: {
        content: {text: 'about to write README.md…', type: 'text'},
        sessionUpdate: 'agent_message_chunk',
      },
    })

    const outcome = await ctx.sendPermissionRequest(
      sessionId,
      [
        {kind: 'allow_once', name: 'Allow', optionId: 'opt-allow'},
        {kind: 'reject_once', name: 'Reject', optionId: 'opt-reject'},
      ],
      {
        kind: 'write',
        locations: [{path: 'README.md'}],
        rawInput: {path: 'README.md'},
        status: 'pending',
        title: 'Write file README.md',
        toolCallId: 'mock-tool-1',
      },
    )

    if (outcome?.outcome?.outcome === 'cancelled') {
      return {stopReason: 'cancelled'}
    }

    if (outcome?.outcome?.outcome === 'selected' && outcome.outcome.optionId === 'opt-reject') {
      return {stopReason: 'refusal'}
    }

    ctx.sendNotification('session/update', {
      sessionId,
      update: {
        content: {text: 'README written.', type: 'text'},
        sessionUpdate: 'agent_message_chunk',
      },
    })
    return {stopReason: 'end_turn'}
  },
  initialize() {
    return {
      agentCapabilities: {promptCapabilities: {embeddedContext: false}},
      agentInfo: {name: 'mock-acp-permission', version: '0.1.0'},
      protocolVersion: 1,
    }
  },
})

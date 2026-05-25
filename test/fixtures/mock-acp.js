#!/usr/bin/env node
// Baseline mock-ACP fixture for Phase 2 integration tests.
//
//  - `initialize` succeeds and advertises NO embeddedContext capability.
//  - `session/new` returns a fresh sessionId.
//  - `session/prompt` streams two `agent_message_chunk` updates and resolves
//    with `stopReason: 'end_turn'`.
//
// See mock-acp-lib.js for the shared NDJSON / JSON-RPC plumbing.

import {start} from './mock-acp-lib.js'

start({
  handlePrompt(params, ctx) {
    const {sessionId} = params
    ctx.sendNotification('session/update', {
      sessionId,
      update: {
        content: {text: 'mock chunk 1', type: 'text'},
        sessionUpdate: 'agent_message_chunk',
      },
    })
    ctx.sendNotification('session/update', {
      sessionId,
      update: {
        content: {text: 'mock chunk 2', type: 'text'},
        sessionUpdate: 'agent_message_chunk',
      },
    })
    return {stopReason: 'end_turn'}
  },
  initialize() {
    return {
      agentCapabilities: {
        promptCapabilities: {embeddedContext: false},
      },
      agentInfo: {name: 'mock-acp', version: '0.1.0'},
      protocolVersion: 1,
    }
  },
})

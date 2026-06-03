#!/usr/bin/env node
// Mock-ACP fixture that emits a thinking chunk before its visible answer, so
// suppress-thoughts behavior can be exercised end-to-end.
//
//  - `initialize` advertises NO embeddedContext capability (classifies as B).
//  - `session/new` returns a fresh sessionId (handled by mock-acp-lib).
//  - `session/prompt` streams one `agent_thought_chunk` then one
//    `agent_message_chunk` and resolves with `stopReason: 'end_turn'`.

import {start} from './mock-acp-lib.js'

start({
  handlePrompt(params, ctx) {
    const {sessionId} = params
    ctx.sendNotification('session/update', {
      sessionId,
      update: {
        content: {text: 'thinking quietly', type: 'text'},
        sessionUpdate: 'agent_thought_chunk',
      },
    })
    ctx.sendNotification('session/update', {
      sessionId,
      update: {
        content: {text: 'visible answer', type: 'text'},
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
      agentInfo: {name: 'mock-acp-thinking', version: '0.1.0'},
      protocolVersion: 1,
    }
  },
})

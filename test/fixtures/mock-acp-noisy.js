#!/usr/bin/env node
// Noisy mock-ACP fixture: exercises the driver's notification hardening.
// Before the two real `agent_message_chunk`s it emits (1) a malformed
// notification with null params and (2) a cross-session update carrying a
// foreign sessionId. A correct driver drops both — without crashing — and
// yields only the two real chunks for this session.
//
// See mock-acp-lib.js for the shared NDJSON / JSON-RPC plumbing.

import {start} from './mock-acp-lib.js'

start({
  handlePrompt(params, ctx) {
    const {sessionId} = params
    // 1. Malformed params (null) — must not crash the driver's handler.
    ctx.sendNotification('session/update', null)
    // 2. Cross-session update — must be filtered out by sessionId.
    ctx.sendNotification('session/update', {
      sessionId: 'other-session',
      update: {
        content: {text: 'LEAKED', type: 'text'},
        sessionUpdate: 'agent_message_chunk',
      },
    })
    // 3-4. The two real chunks for THIS session.
    ctx.sendNotification('session/update', {
      sessionId,
      update: {
        content: {text: 'real chunk 1', type: 'text'},
        sessionUpdate: 'agent_message_chunk',
      },
    })
    ctx.sendNotification('session/update', {
      sessionId,
      update: {
        content: {text: 'real chunk 2', type: 'text'},
        sessionUpdate: 'agent_message_chunk',
      },
    })
    return {stopReason: 'end_turn'}
  },
  initialize() {
    return {
      agentCapabilities: {promptCapabilities: {embeddedContext: false}},
      agentInfo: {name: 'mock-acp-noisy', version: '0.1.0'},
      protocolVersion: 1,
    }
  },
})

#!/usr/bin/env node
// Phase-8 fixture for Slice 8.0 — emits BOTH `agent_thought_chunk` AND
// `agent_message_chunk` updates so tests can assert the orchestrator's
// `suppressThoughts` filter (thoughts dropped at persist/broadcast).
//
// Identical to mock-acp.js except for the additional thought emission.
// See mock-acp-lib.js for shared NDJSON / JSON-RPC plumbing.

import {start} from './mock-acp-lib.js'

start({
  handlePrompt(params, ctx) {
    const {sessionId} = params
    // Reasoning trace — Slice 8.0 `suppressThoughts: true` MUST drop these.
    ctx.sendNotification('session/update', {
      sessionId,
      update: {
        content: {text: 'thinking step 1', type: 'text'},
        sessionUpdate: 'agent_thought_chunk',
      },
    })
    ctx.sendNotification('session/update', {
      sessionId,
      update: {
        content: {text: 'thinking step 2', type: 'text'},
        sessionUpdate: 'agent_thought_chunk',
      },
    })
    // User-visible answer chunks — always forwarded.
    ctx.sendNotification('session/update', {
      sessionId,
      update: {
        content: {text: 'visible chunk A', type: 'text'},
        sessionUpdate: 'agent_message_chunk',
      },
    })
    ctx.sendNotification('session/update', {
      sessionId,
      update: {
        content: {text: 'visible chunk B', type: 'text'},
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

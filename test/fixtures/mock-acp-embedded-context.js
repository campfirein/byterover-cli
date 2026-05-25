#!/usr/bin/env node
// mock-ACP fixture that advertises `promptCapabilities.embeddedContext: true`.
// Used by `channel-phase2-lookback-capability.test.ts` to verify the
// lookback builder emits a `resource` block (instead of the baseline `text`
// fallback).

import {start} from './mock-acp-lib.js'

start({
  handlePrompt(params, ctx) {
    const {sessionId} = params
    ctx.sendNotification('session/update', {
      sessionId,
      update: {
        content: {text: 'embedded-context mock chunk', type: 'text'},
        sessionUpdate: 'agent_message_chunk',
      },
    })
    return {stopReason: 'end_turn'}
  },
  initialize() {
    return {
      agentCapabilities: {promptCapabilities: {embeddedContext: true}},
      agentInfo: {name: 'mock-acp-embedded-context', version: '0.1.0'},
      protocolVersion: 1,
    }
  },
})

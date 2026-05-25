#!/usr/bin/env node
// mock-ACP fixture for §7.2 cancellation-ordering test.
//
// Sends a permission request, then (regardless of the host's response)
// blocks until the host sends `session/cancel`. The integration test fires
// `channel:cancel` while the permission is still pending; the orchestrator
// must (in order):
//   1. Emit permission_decision { outcome: 'cancelled' }
//   2. Emit delivery_state_change { to: 'cancelled' }
//   3. Emit turn_state_change { to: 'cancelled' }
// and send `session/cancel` to this fixture, at which point we resolve
// `session/prompt` with `stopReason: 'cancelled'`.

import {start} from './mock-acp-lib.js'

let resolveCancelled
const cancelledPromise = new Promise((resolve) => {
  resolveCancelled = resolve
})

start({
  async handleCancel() {
    resolveCancelled()
  },
  async handlePrompt(params, ctx) {
    const {sessionId} = params

    ctx.sendNotification('session/update', {
      sessionId,
      update: {
        content: {text: 'thinking… (long task)', type: 'text'},
        sessionUpdate: 'agent_message_chunk',
      },
    })

    // Fire-and-forget the permission request — we don't await it because
    // the test wants us blocked on `session/cancel`, not on the user.
    ctx.sendPermissionRequest(
      sessionId,
      [
        {kind: 'allow_once', name: 'Allow', optionId: 'opt-allow'},
        {kind: 'reject_once', name: 'Reject', optionId: 'opt-reject'},
      ],
      {
        kind: 'execute',
        locations: [],
        rawInput: {command: 'sleep 60'},
        status: 'pending',
        title: 'Run sleep 60',
        toolCallId: 'mock-tool-slow-1',
      },
    )

    await cancelledPromise
    return {stopReason: 'cancelled'}
  },
  initialize() {
    return {
      agentCapabilities: {promptCapabilities: {embeddedContext: false}},
      agentInfo: {name: 'mock-acp-slow', version: '0.1.0'},
      protocolVersion: 1,
    }
  },
})

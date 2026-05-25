#!/usr/bin/env node
// Mock-ACP fixture for the Bug 1 CLI-timeout regression test.
//
// `handlePrompt` streams one chunk, then sleeps for `MOCK_ACP_SLEEP_MS`
// (default 5000ms; configurable via env), then resolves with
// `stopReason: 'end_turn'`. Used by `channel-phase8-bug1-cli-timeout.test.ts`
// to prove that `brv channel mention --mode sync --timeout T` keeps the
// transport socket open until the daemon's sync resolver settles — even
// when the per-request transport default (`BRV_CHANNEL_REQUEST_TIMEOUT_MS`)
// is shorter than the agent's actual work time.
//
// Bug 1 regression: the CLI-internal request() previously used a 60s
// hardcoded transport timeout; the fix made it `turn_timeout + grace`.

import {start} from './mock-acp-lib.js'

const SLEEP_MS = Number.parseInt(process.env.MOCK_ACP_SLEEP_MS ?? '5000', 10)

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

start({
  async handlePrompt(params, ctx) {
    const {sessionId} = params
    ctx.sendNotification('session/update', {
      sessionId,
      update: {
        content: {text: 'pre-sleep chunk', type: 'text'},
        sessionUpdate: 'agent_message_chunk',
      },
    })

    await sleep(SLEEP_MS)

    ctx.sendNotification('session/update', {
      sessionId,
      update: {
        content: {text: 'post-sleep chunk', type: 'text'},
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
      agentInfo: {name: 'mock-acp-delayed-end', version: '0.1.0'},
      protocolVersion: 1,
    }
  },
})

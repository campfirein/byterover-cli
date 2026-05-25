#!/usr/bin/env node
// Post-merge review fixture #3: an ACP agent that hangs on `session/prompt`.
//
// initialize + session/new succeed, but `session/prompt` returns a
// promise that NEVER resolves. Used to verify that `AcpDriver.cancel()`
// unblocks `iteratePromptQueue` instead of leaking the background task.

import {start} from './mock-acp-lib.js'

start({
  handlePrompt() {
    return new Promise(() => {
      // Intentionally never resolves. Cancel must short-circuit the iterator.
    })
  },
  initialize() {
    return {
      agentCapabilities: {promptCapabilities: {embeddedContext: true}},
      protocolVersion: 1,
    }
  },
})

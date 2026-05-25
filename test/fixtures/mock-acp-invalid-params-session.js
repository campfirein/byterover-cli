#!/usr/bin/env node
// Phase-4 regression fixture: rejects `session/new` with -32602 Invalid params
// and **no** `authMethods` in data. Real kimi-cli does this when params fail
// Pydantic validation (e.g. missing `cwd`). The driver must classify this as
// a generic handshake/session failure, NOT as AUTH_REQUIRED.

import {start} from './mock-acp-lib.js'

start({
  handlePrompt() {
    throw new Error('handshake should have failed before any prompt')
  },
  handleSessionNew() {
    const error = new Error('Invalid params: cwd required')
    error.acpErrorCode = -32_602
    // Intentionally NO acpErrorData — generic validation error, not auth.
    return error
  },
  initialize() {
    return {
      agentCapabilities: {
        promptCapabilities: {embeddedContext: true, image: true},
      },
      protocolVersion: 1,
    }
  },
})

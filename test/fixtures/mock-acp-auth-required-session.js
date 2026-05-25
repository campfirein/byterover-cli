#!/usr/bin/env node
// Phase-4 fixture: AUTH_REQUIRED raised from `session/new` (matches the
// real kimi-cli code path — `_check_auth()` is called inside `new_session`,
// see kimi-cli/src/kimi_cli/acp/server.py:158).
//
// `initialize` succeeds with a class-A capability set so the driver gets
// past the handshake; `session/new` is where the auth error surfaces.

import {start} from './mock-acp-lib.js'

start({
  handlePrompt() {
    throw new Error('session/new should have failed before any prompt')
  },
  handleSessionNew() {
    const error = new Error('Authentication required')
    error.acpErrorCode = -32_000
    error.acpErrorData = {
      authMethods: [
        {
          description: 'Run `kimi login` to authenticate',
          fieldMeta: {
            terminalAuth: {args: ['login'], command: 'kimi', env: {}},
          },
          id: 'login',
          name: 'Login with Kimi account',
        },
      ],
    }
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

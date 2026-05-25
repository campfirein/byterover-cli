#!/usr/bin/env node
// Phase-4 fixture: kimi-style AUTH_REQUIRED raised from `initialize`.
//
// JSON-RPC error code -32000 with structured `data.authMethods` — exactly
// the shape the real `kimi acp` server sends when the user has not run
// `kimi login` (verified in upstream kimi-cli/src/kimi_cli/acp/server.py:148
// and tests/ui_and_conv/test_acp_server_auth.py:53).

import {start} from './mock-acp-lib.js'

start({
  handlePrompt() {
    throw new Error('handshake should have failed before any prompt')
  },
  initialize() {
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
    throw error
  },
})

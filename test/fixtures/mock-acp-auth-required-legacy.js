#!/usr/bin/env node
// Phase-4 fixture: legacy `-32602` AUTH_REQUIRED variant — exercises the
// defensive classifier path in AcpDriver. Real kimi uses -32000; this
// fixture exists so the slice 4.2 unit tests cover both code paths.

import {start} from './mock-acp-lib.js'

start({
  handlePrompt() {
    throw new Error('handshake should have failed before any prompt')
  },
  initialize() {
    const error = new Error('Authentication required (legacy code)')
    error.acpErrorCode = -32_602
    error.acpErrorData = {
      authMethods: [
        {id: 'login', name: 'Login with the agent CLI'},
      ],
    }
    throw error
  },
})

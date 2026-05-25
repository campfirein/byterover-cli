#!/usr/bin/env node
// mock-ACP fixture that fails the `initialize` handshake. Used by
// `channel-phase2-invite-initialize.test.ts` to verify `brv channel invite`
// rejects with `ACP_HANDSHAKE_FAILED` and does not persist the member.

import {start} from './mock-acp-lib.js'

start({
  handlePrompt() {
    throw new Error('handshake should have failed before any prompt')
  },
  initialize() {
    throw new Error('mock-acp-bad-handshake: refusing to initialize')
  },
})

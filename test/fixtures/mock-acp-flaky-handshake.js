import {start} from './mock-acp-lib.js'

// Flaky-handshake mock: ACP `initialize` succeeds (so a Phase-2 invite
// would persist the member) BUT `session/new` errors out. Phase-3
// onboarding's multi-stage probe MUST surface this as a Class C-prime
// classification AND a DoctorDiagnostic of severity 'error' WITHOUT
// persisting the profile (per onboard-failure DoD).
start({
  handlePrompt: () => ({stopReason: 'end_turn'}),
  handleSessionNew: () => new Error('mock-acp-flaky-handshake: session/new not implemented'),
  initialize: () => ({
    agentCapabilities: {promptCapabilities: {embeddedContext: false}},
    protocolVersion: 1,
  }),
})

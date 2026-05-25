import {start} from './mock-acp-lib.js'

// Class-A mock: advertises the full ACP-native capability set. Phase-3
// onboarding's driver-class classifier MUST tag this fixture as 'A'.
start({
  handlePrompt(_params, {sendNotification}) {
    sendNotification('session/update', {
      sessionId: _params.sessionId,
      update: {content: {text: 'class-A reply', type: 'text'}, sessionUpdate: 'agent_message_chunk'},
    })
    return {stopReason: 'end_turn'}
  },
  initialize: () => ({
    agentCapabilities: {
      promptCapabilities: {
        embeddedContext: true,
        image: true,
      },
      toolCallSupport: true,
    },
    protocolVersion: 1,
  }),
})

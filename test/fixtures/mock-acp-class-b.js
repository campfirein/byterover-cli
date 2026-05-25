import {start} from './mock-acp-lib.js'

// Class-B mock: ACP-compatible baseline. No embedded context, no image
// support, but `session/new` succeeds — Phase-3 classifier tags it as 'B'.
start({
  handlePrompt(_params, {sendNotification}) {
    sendNotification('session/update', {
      sessionId: _params.sessionId,
      update: {content: {text: 'class-B reply', type: 'text'}, sessionUpdate: 'agent_message_chunk'},
    })
    return {stopReason: 'end_turn'}
  },
  initialize: () => ({
    agentCapabilities: {
      promptCapabilities: {
        embeddedContext: false,
        image: false,
      },
    },
    protocolVersion: 1,
  }),
})

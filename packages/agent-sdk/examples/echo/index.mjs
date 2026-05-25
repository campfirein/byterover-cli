#!/usr/bin/env node
// `echo` — the minimal `@brv/agent-sdk` example. ~25 LOC.
//
// Onboard with:
//   brv channel onboard echo -- node packages/agent-sdk/examples/echo/index.mjs
//
// Mention with:
//   brv channel mention <ch> "@echo hello"
//
// See packages/agent-sdk/examples/echo/README.md for the full walkthrough.

import {ChannelAgent} from '@brv/agent-sdk'

const agent = new ChannelAgent({
  name: 'echo',
  promptCapabilities: {embeddedContext: true},
  version: '0.1.0',
})

agent.onPrompt(async (req, ctx) => {
  const userText = req.prompt
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
  await ctx.sendMessageChunk(`you said: ${userText}`)
  return {stopReason: 'end_turn'}
})

agent.run()

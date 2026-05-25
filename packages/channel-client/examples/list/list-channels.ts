// Smoke-test example for @brv/channel-client.
//
// Prereq: a running `brv` daemon (any prior CLI command will boot one).
// Usage: `npx tsx examples/list/list-channels.ts`
//
// Prints the list of channels visible to the daemon. Wires no agent loop,
// just demonstrates the connect → request → close shape so downstream
// consumers (Pi extension, kimi-cli wrapper) can model their own usage.

import {ChannelClient, ChannelClientError} from '../../src/index.js'

type ChannelSummary = {
  readonly channelId: string
  readonly title?: string
  readonly state?: string
}

async function main(): Promise<void> {
  let client: ChannelClient
  try {
    client = await ChannelClient.connect()
  } catch (error) {
    if (error instanceof ChannelClientError) {
      console.error(`[${error.code}] ${error.message}`)
      process.exitCode = 1
      return
    }

    throw error
  }

  try {
    const result = await client.request<unknown, {channels: ChannelSummary[]}>('channel:list', {})
    if (result.channels.length === 0) {
      console.log('(no channels — create one with `brv channel create <id>`)')
      return
    }

    for (const channel of result.channels) {
      const title = channel.title ?? '(untitled)'
      const state = channel.state ?? 'unknown'
      console.log(`${channel.channelId.padEnd(20)} ${state.padEnd(10)} ${title}`)
    }
  } finally {
    await client.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

import {type Config, Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import {fileURLToPath} from 'node:url'

import type {TransportConnector} from '../../src/server/infra/transport/transport-connector.js'

import ChannelInvite from '../../src/oclif/commands/channel/invite.js'
import ChannelMention from '../../src/oclif/commands/channel/mention.js'
import ChannelNew from '../../src/oclif/commands/channel/new.js'
import ChannelOnboard from '../../src/oclif/commands/channel/onboard.js'
import {ChannelCommand} from '../../src/oclif/lib/channel-command.js'
import {FileTranscriptStore} from '../../src/server/infra/channel/storage/file-transcript-store.js'
import {type ChannelHarness, startChannelHarness} from '../helpers/channel-test-harness.js'

const MOCK_ACP_THINKING = fileURLToPath(new URL('../fixtures/mock-acp-thinking.js', import.meta.url))

class CommandExited extends Error {
  public readonly code: number

  public constructor(code: number) {
    super(`command exited with ${code}`)
    this.name = 'CommandExited'
    this.code = code
  }
}

type ChannelCommandClass = new (argv: string[], config: Config) => ChannelCommand

async function runInProcess(
  CommandClass: ChannelCommandClass,
  config: Config,
  connector: TransportConnector,
  argv: string[],
): Promise<{exitCode: number | undefined; logs: string[]}> {
  const command = new CommandClass(argv, config)
  const logs: string[] = []
  let exitCode: number | undefined

  command.channelClientOptions = () => ({projectPath: process.cwd(), retryDelayMs: 0, transportConnector: connector})
  command.log = (message = '') => {
    logs.push(message)
  }

  command.logToStderr = () => {}
  command.exit = (code = 0) => {
    throw new CommandExited(code)
  }

  try {
    await command.run()
  } catch (error) {
    if (!(error instanceof CommandExited)) throw error
    exitCode = error.code
  }

  return {exitCode, logs}
}

describe('channel sync mention suppress-thoughts', () => {
  let config: Config
  let harness: ChannelHarness

  before(async () => {
    config = await OclifConfig.load(import.meta.url)
  })

  beforeEach(async () => {
    harness = await startChannelHarness({enabled: true})
  })

  afterEach(async () => {
    await harness.teardown()
  })

  const setupThinker = async (channelId: string): Promise<void> => {
    await runInProcess(ChannelOnboard, config, harness.connector, ['thinker', '--', process.execPath, MOCK_ACP_THINKING])
    await runInProcess(ChannelNew, config, harness.connector, [channelId, '--json'])
    await runInProcess(ChannelInvite, config, harness.connector, [channelId, '@thinker', '--profile', 'thinker'])
  }

  it('drops agent_thought_chunk from the final answer AND the on-disk transcript', async () => {
    await setupThinker('s')
    const mentioned = await runInProcess(ChannelMention, config, harness.connector, [
      's',
      '@thinker go',
      '--mode',
      'sync',
      '--suppress-thoughts',
      '--json',
    ])
    expect(mentioned.exitCode).to.equal(undefined)
    const result = JSON.parse(mentioned.logs.at(-1) ?? '{}')
    expect(result.finalAnswer).to.equal('visible answer')

    const events = await new FileTranscriptStore().readTurnEvents({
      channelId: 's',
      projectRoot: harness.projectRoot,
      turnId: result.turnId,
    })
    expect(events.some((e) => e.kind === 'agent_thought_chunk')).to.equal(false)
    expect(events.some((e) => e.kind === 'agent_message_chunk')).to.equal(true)
  })

  it('keeps agent_thought_chunk on disk when suppression is off', async () => {
    await setupThinker('k')
    const mentioned = await runInProcess(ChannelMention, config, harness.connector, [
      'k',
      '@thinker go',
      '--mode',
      'sync',
      '--json',
    ])
    const result = JSON.parse(mentioned.logs.at(-1) ?? '{}')

    const events = await new FileTranscriptStore().readTurnEvents({
      channelId: 'k',
      projectRoot: harness.projectRoot,
      turnId: result.turnId,
    })
    expect(events.some((e) => e.kind === 'agent_thought_chunk')).to.equal(true)
  })
})

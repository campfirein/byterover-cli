import {type Config, Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import {fileURLToPath} from 'node:url'

import type {TransportConnector} from '../../src/server/infra/transport/transport-connector.js'

import ChannelInvite from '../../src/oclif/commands/channel/invite.js'
import ChannelMention from '../../src/oclif/commands/channel/mention.js'
import ChannelNew from '../../src/oclif/commands/channel/new.js'
import ChannelOnboard from '../../src/oclif/commands/channel/onboard.js'
import {ChannelCommand} from '../../src/oclif/lib/channel-command.js'
import {type ChannelHarness, startChannelHarness} from '../helpers/channel-test-harness.js'

const MOCK_ACP = fileURLToPath(new URL('../fixtures/mock-acp.js', import.meta.url))

class CommandExited extends Error {
  public readonly code: number

  public constructor(code: number) {
    super(`command exited with ${code}`)
    this.name = 'CommandExited'
    this.code = code
  }
}

type ChannelCommandClass = new (argv: string[], config: Config) => ChannelCommand

type RunResult = {exitCode: number | undefined; logs: string[]; stderrLogs: string[]}

async function runInProcess(
  CommandClass: ChannelCommandClass,
  config: Config,
  connector: TransportConnector,
  argv: string[],
): Promise<RunResult> {
  const command = new CommandClass(argv, config)
  const logs: string[] = []
  const stderrLogs: string[] = []
  let exitCode: number | undefined

  command.channelClientOptions = () => ({projectPath: process.cwd(), retryDelayMs: 0, transportConnector: connector})
  command.log = (message = '') => {
    logs.push(message)
  }

  command.logToStderr = (message = '') => {
    stderrLogs.push(message)
  }

  command.exit = (code = 0) => {
    throw new CommandExited(code)
  }

  try {
    await command.run()
  } catch (error) {
    if (!(error instanceof CommandExited)) throw error
    exitCode = error.code
  }

  return {exitCode, logs, stderrLogs}
}

describe('channel sync mention (single member, happy path)', () => {
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

  it('onboard → new → invite → mention --mode sync returns a completed finalAnswer', async () => {
    const onboard = await runInProcess(ChannelOnboard, config, harness.connector, [
      'mock',
      '--',
      process.execPath,
      MOCK_ACP,
    ])
    expect(onboard.exitCode, `onboard failed: ${onboard.stderrLogs.join(' ')}`).to.equal(undefined)

    const created = await runInProcess(ChannelNew, config, harness.connector, ['x', '--json'])
    expect(created.exitCode, `new failed: ${created.stderrLogs.join(' ')}`).to.equal(undefined)

    const invited = await runInProcess(ChannelInvite, config, harness.connector, ['x', '@mock', '--profile', 'mock'])
    expect(invited.exitCode, `invite failed: ${invited.stderrLogs.join(' ')}`).to.equal(undefined)

    const mentioned = await runInProcess(ChannelMention, config, harness.connector, [
      'x',
      '@mock do the thing',
      '--mode',
      'sync',
      '--json',
    ])
    expect(mentioned.exitCode, `mention failed: ${mentioned.stderrLogs.join(' ')}`).to.equal(undefined)

    const result = JSON.parse(mentioned.logs.at(-1) ?? '{}')
    expect(result.endedState).to.equal('completed')
    expect(result.finalAnswer).to.equal('mock chunk 1mock chunk 2')
  })

  it('inviting an unknown profile fails with a typed code', async () => {
    await runInProcess(ChannelNew, config, harness.connector, ['y', '--json'])
    const invited = await runInProcess(ChannelInvite, config, harness.connector, ['y', '@ghost', '--profile', 'ghost', '--json'])

    expect(invited.exitCode).to.equal(1)
    const parsed = JSON.parse(invited.logs.at(-1) ?? '{}')
    expect(parsed.code).to.equal('CHANNEL_DRIVER_PROFILE_NOT_FOUND')
  })
})

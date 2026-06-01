import {type Config, Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'

import type {TransportConnector} from '../../src/server/infra/transport/transport-connector.js'

import ChannelInvite from '../../src/oclif/commands/channel/invite.js'
import ChannelListTurns from '../../src/oclif/commands/channel/list-turns.js'
import ChannelList from '../../src/oclif/commands/channel/list.js'
import ChannelMention from '../../src/oclif/commands/channel/mention.js'
import ChannelNew from '../../src/oclif/commands/channel/new.js'
import ChannelOnboard from '../../src/oclif/commands/channel/onboard.js'
import ChannelShow from '../../src/oclif/commands/channel/show.js'
import {ChannelCommand} from '../../src/oclif/lib/channel-command.js'
import {type ChannelHarness, startChannelHarness} from '../helpers/channel-test-harness.js'

/** Thrown by the testable command's `exit()` override so the runner reads the code via `instanceof`. */
class CommandExited extends Error {
  public readonly code: number

  public constructor(code: number) {
    super(`command exited with ${code}`)
    this.name = 'CommandExited'
    this.code = code
  }
}

type ChannelCommandClass = new (argv: string[], config: Config) => ChannelCommand

type RunResult = {
  exitCode: number | undefined
  logs: string[]
  stderrLogs: string[]
}

/** Narrows a parsed JSON value to the channel error envelope shape. */
function isErrorEnvelope(value: unknown): value is {code: string; error: string; success: boolean} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'error' in value &&
    'success' in value &&
    typeof value.code === 'string' &&
    typeof value.error === 'string' &&
    typeof value.success === 'boolean'
  )
}

/**
 * Drives a real channel command in-process. The injected connector points
 * `withChannelClient`/`withDaemonRetry` at the harness transport server, so the
 * full command → daemon client → handler → typed-error → render round-trip runs
 * with no subprocess and no daemon spawn. `log`/`logToStderr` are captured, and
 * `exit()` is overridden to surface the exit code without a cast.
 */
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

  // Set the instance hooks (no subclass needed): inject the harness connector
  // and capture stdout/stderr/exit in-process.
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

function parseEnvelope(logs: string[]): unknown {
  return JSON.parse(logs.at(-1) ?? '{}')
}

/** One representative, schema-valid invocation per command. */
const COMMAND_CASES: ReadonlyArray<{argv: string[]; commandClass: ChannelCommandClass; label: string}> = [
  {argv: ['my-channel', '--json'], commandClass: ChannelNew, label: 'new'},
  {argv: ['--json'], commandClass: ChannelList, label: 'list'},
  {argv: ['my-channel', '@codex', '--json'], commandClass: ChannelInvite, label: 'invite'},
  {argv: ['@codex', '--channel', 'my-channel', '--json'], commandClass: ChannelOnboard, label: 'onboard'},
  {argv: ['my-channel', 'hello @codex', '--json'], commandClass: ChannelMention, label: 'mention'},
  {argv: ['my-channel', 'turn-1', '--json'], commandClass: ChannelShow, label: 'show'},
  {argv: ['my-channel', '--json'], commandClass: ChannelListTurns, label: 'list-turns'},
]

describe('channel-command-surface', () => {
  let config: Config

  before(async () => {
    config = await OclifConfig.load(import.meta.url)
  })

  describe('enabled surface (BRV_CHANNELS_ENABLED=1)', () => {
    let harness: ChannelHarness

    beforeEach(async () => {
      harness = await startChannelHarness({enabled: true})
    })

    afterEach(async () => {
      await harness.teardown()
    })

    for (const {argv, commandClass, label} of COMMAND_CASES) {
      it(`\`channel ${label}\` builds a schema-valid request that reaches CHANNEL_NOT_IMPLEMENTED`, async () => {
        const {exitCode, logs} = await runInProcess(commandClass, config, harness.connector, argv)

        expect(exitCode, label).to.equal(1)
        const parsed = parseEnvelope(logs)
        expect(isErrorEnvelope(parsed), label).to.equal(true)
        if (isErrorEnvelope(parsed)) {
          expect(parsed.code, label).to.equal('CHANNEL_NOT_IMPLEMENTED')
        }
      })
    }

    it('emits a `{success:false, code, error}` envelope on stdout in JSON mode', async () => {
      const {exitCode, logs} = await runInProcess(ChannelNew, config, harness.connector, ['x', '--json'])

      expect(exitCode).to.equal(1)
      const parsed = parseEnvelope(logs)
      expect(isErrorEnvelope(parsed)).to.equal(true)
      if (isErrorEnvelope(parsed)) {
        expect(parsed.code).to.equal('CHANNEL_NOT_IMPLEMENTED')
        expect(parsed.success).to.equal(false)
        expect(parsed.error).to.have.length.greaterThan(0)
      }
    })

    it('renders a [CODE] message to stderr in text mode', async () => {
      const {exitCode, stderrLogs} = await runInProcess(ChannelNew, config, harness.connector, ['x'])

      expect(exitCode).to.equal(1)
      expect(stderrLogs.join('\n')).to.include('[CHANNEL_NOT_IMPLEMENTED]')
    })

    it('surfaces CHANNEL_INVALID_REQUEST when an invited handle is missing the @ prefix', async () => {
      const {exitCode, logs} = await runInProcess(ChannelInvite, config, harness.connector, ['my-channel', 'codex', '--json'])

      expect(exitCode).to.equal(1)
      const parsed = parseEnvelope(logs)
      expect(isErrorEnvelope(parsed)).to.equal(true)
      if (isErrorEnvelope(parsed)) {
        expect(parsed.code).to.equal('CHANNEL_INVALID_REQUEST')
      }
    })
  })

  describe('disabled surface (BRV_CHANNELS_ENABLED=0)', () => {
    let harness: ChannelHarness

    beforeEach(async () => {
      harness = await startChannelHarness({enabled: false})
    })

    afterEach(async () => {
      await harness.teardown()
    })

    it('round-trips `channel new x --json` to a CHANNEL_DISABLED envelope and exits non-zero', async () => {
      const {exitCode, logs} = await runInProcess(ChannelNew, config, harness.connector, ['x', '--json'])

      expect(exitCode).to.equal(1)
      const parsed = parseEnvelope(logs)
      expect(isErrorEnvelope(parsed)).to.equal(true)
      if (isErrorEnvelope(parsed)) {
        expect(parsed.code).to.equal('CHANNEL_DISABLED')
        expect(parsed.success).to.equal(false)
      }
    })
  })
})

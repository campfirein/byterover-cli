import {type Config, Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'

import ChannelInvite from '../../../src/oclif/commands/channel/invite.js'
import ChannelListTurns from '../../../src/oclif/commands/channel/list-turns.js'
import ChannelList from '../../../src/oclif/commands/channel/list.js'
import ChannelMention from '../../../src/oclif/commands/channel/mention.js'
import ChannelNew from '../../../src/oclif/commands/channel/new.js'
import ChannelOnboard from '../../../src/oclif/commands/channel/onboard.js'
import ChannelShow from '../../../src/oclif/commands/channel/show.js'
import {ChannelClientError} from '../../../src/oclif/lib/channel-client.js'
import {ChannelCommand} from '../../../src/oclif/lib/channel-command.js'

/** Exposes the protected base hook and captures its output for assertions. */
class ProbeCommand extends ChannelCommand {
  public exitCode: number | undefined
  public readonly logs: string[] = []
  public readonly stderrLogs: string[] = []

  public override exit(code = 0): never {
    this.exitCode = code
    throw new Error('__probe_exit__')
  }

  public invokeHandleError(error: unknown, asJson: boolean): void {
    this.handleError(error, asJson)
  }

  public override log(message = ''): void {
    this.logs.push(message)
  }

  public override logToStderr(message = ''): void {
    this.stderrLogs.push(message)
  }

  public async run(): Promise<void> {}
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

const COMMANDS: ReadonlyArray<typeof ChannelCommand> = [
  ChannelInvite,
  ChannelList,
  ChannelListTurns,
  ChannelMention,
  ChannelNew,
  ChannelOnboard,
  ChannelShow,
]

describe('channel commands', () => {
  describe('statics', () => {
    for (const Command of COMMANDS) {
      describe(Command.name, () => {
        it('extends ChannelCommand', () => {
          expect(Command.prototype instanceof ChannelCommand).to.equal(true)
        })

        it('declares a non-empty description', () => {
          expect(Command.description).to.be.a('string').with.length.greaterThan(0)
        })

        it('exposes the --json base flag', () => {
          expect(Command.baseFlags).to.have.property('json')
        })
      })
    }
  })

  describe('handleError', () => {
    let config: Config

    before(async () => {
      config = await OclifConfig.load(import.meta.url)
    })

    it('emits a {success:false, code, error} envelope and exits 1 in JSON mode', () => {
      const command = new ProbeCommand([], config)

      expect(() => command.invokeHandleError(new ChannelClientError('CHANNEL_X', 'nope'), true)).to.throw()
      expect(command.exitCode).to.equal(1)
      const parsed: unknown = JSON.parse(command.logs.at(-1) ?? '{}')
      expect(isErrorEnvelope(parsed)).to.equal(true)
      if (isErrorEnvelope(parsed)) {
        expect(parsed).to.deep.equal({code: 'CHANNEL_X', error: 'nope', success: false})
      }
    })

    it('renders a [CODE] message to stderr and exits 1 in text mode', () => {
      const command = new ProbeCommand([], config)

      expect(() => command.invokeHandleError(new ChannelClientError('CHANNEL_X', 'nope'), false)).to.throw()
      expect(command.exitCode).to.equal(1)
      expect(command.stderrLogs.join('\n')).to.equal('[CHANNEL_X] nope')
      expect(command.logs).to.have.length(0)
    })

    it('rethrows a non-channel error without logging or exiting', () => {
      const command = new ProbeCommand([], config)

      expect(() => command.invokeHandleError(new Error('boom'), true)).to.throw('boom')
      expect(command.exitCode).to.equal(undefined)
      expect(command.logs).to.have.length(0)
      expect(command.stderrLogs).to.have.length(0)
    })
  })
})

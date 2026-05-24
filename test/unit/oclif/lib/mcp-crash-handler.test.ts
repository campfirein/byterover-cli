import {expect} from 'chai'
import {type SinonStub, stub} from 'sinon'

import {createMcpCrashHandlers} from '../../../../src/oclif/lib/mcp-crash-handler.js'

const FIXED_NOW = new Date('2026-05-14T12:00:00.000Z')

type DepStubs = {
  exit: SinonStub
  fileWrite: SinonStub
  now: () => Date
  stderrWrite: SinonStub
}

const makeDeps = (overrides: Partial<DepStubs> = {}): DepStubs => ({
  exit: stub(),
  fileWrite: stub(),
  now: () => FIXED_NOW,
  stderrWrite: stub(),
  ...overrides,
})

describe('createMcpCrashHandlers', () => {
  it('logs to stderr and file, then exits(1) on Error uncaughtException', () => {
    const deps = makeDeps()
    const handlers = createMcpCrashHandlers(deps)

    handlers.onUncaughtException(new Error('boom'))

    expect(deps.stderrWrite.callCount).to.equal(1)
    expect(deps.stderrWrite.firstCall.args[0]).to.include('Uncaught exception')
    expect(deps.stderrWrite.firstCall.args[0]).to.include('boom')
    expect(deps.fileWrite.callCount).to.equal(1)
    expect(deps.fileWrite.firstCall.args[0]).to.include('Uncaught exception')
    expect(deps.fileWrite.firstCall.args[0]).to.include('boom')
    expect(deps.fileWrite.firstCall.args[0]).to.include(FIXED_NOW.toISOString())
    expect(deps.exit.callCount).to.equal(1)
    expect(deps.exit.firstCall.args[0]).to.equal(1)
  })

  it('coerces non-Error reason via String() on unhandledRejection', () => {
    const deps = makeDeps()
    const handlers = createMcpCrashHandlers(deps)

    handlers.onUnhandledRejection('plain string reason')

    expect(deps.stderrWrite.firstCall.args[0]).to.include('Unhandled rejection')
    expect(deps.stderrWrite.firstCall.args[0]).to.include('plain string reason')
    expect(deps.exit.callCount).to.equal(1)
  })

  it('still calls fileWrite and exit(1) when stderrWrite throws (EPIPE-style)', () => {
    const deps = makeDeps({
      stderrWrite: stub().throws(Object.assign(new Error('EPIPE'), {code: 'EPIPE'})),
    })
    const handlers = createMcpCrashHandlers(deps)

    expect(() => handlers.onUncaughtException(new Error('boom'))).to.not.throw()

    expect(deps.fileWrite.callCount).to.equal(1)
    expect(deps.exit.callCount).to.equal(1)
    expect(deps.exit.firstCall.args[0]).to.equal(1)
  })

  it('still calls exit(1) when fileWrite throws', () => {
    const deps = makeDeps({fileWrite: stub().throws(new Error('disk full'))})
    const handlers = createMcpCrashHandlers(deps)

    expect(() => handlers.onUncaughtException(new Error('boom'))).to.not.throw()

    expect(deps.stderrWrite.callCount).to.equal(1)
    expect(deps.exit.callCount).to.equal(1)
  })

  it('prefixes message with error name when stack is missing', () => {
    const deps = makeDeps()
    const handlers = createMcpCrashHandlers(deps)

    const noStack = new TypeError('something is undefined')
    delete noStack.stack

    handlers.onUncaughtException(noStack)

    expect(deps.stderrWrite.firstCall.args[0]).to.include('TypeError: something is undefined')
    expect(deps.fileWrite.firstCall.args[0]).to.include('TypeError: something is undefined')
    expect(deps.exit.firstCall.args[0]).to.equal(1)
  })

  it('falls back to bare message when name is missing but stack is too', () => {
    const deps = makeDeps()
    const handlers = createMcpCrashHandlers(deps)

    const bare = new Error('lonely message')
    delete bare.stack
    Object.defineProperty(bare, 'name', {value: ''})

    handlers.onUncaughtException(bare)

    expect(deps.stderrWrite.firstCall.args[0]).to.equal('[brv-mcp] Uncaught exception: lonely message\n')
  })

  it('handles hostile error whose stack getter and toString both throw', () => {
    const hostile = Object.create(Error.prototype)
    Object.defineProperty(hostile, 'stack', {
      get() {
        throw new Error('nope stack')
      },
    })
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new Error('nope message')
      },
    })
    Object.defineProperty(hostile, 'toString', {
      value() {
        throw new Error('nope toString')
      },
    })

    const deps = makeDeps()
    const handlers = createMcpCrashHandlers(deps)

    expect(() => handlers.onUncaughtException(hostile)).to.not.throw()

    expect(deps.stderrWrite.callCount).to.equal(1)
    expect(deps.stderrWrite.firstCall.args[0]).to.include('<unprintable error>')
    expect(deps.exit.callCount).to.equal(1)
  })

  it('short-circuits on re-entry: subsequent invocations do not call exit again', () => {
    const deps = makeDeps()
    const handlers = createMcpCrashHandlers(deps)

    handlers.onUncaughtException(new Error('first'))
    handlers.onUncaughtException(new Error('second'))
    handlers.onUnhandledRejection('third')

    expect(deps.exit.callCount).to.equal(1)
    expect(deps.stderrWrite.callCount).to.equal(1)
    expect(deps.fileWrite.callCount).to.equal(1)
  })

  it('does not throw when exit itself throws', () => {
    const deps = makeDeps({exit: stub().throws(new Error('exit failed'))})
    const handlers = createMcpCrashHandlers(deps)

    expect(() => handlers.onUncaughtException(new Error('boom'))).to.not.throw()
  })
})

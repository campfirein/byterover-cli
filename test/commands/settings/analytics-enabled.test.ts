import type {ConnectionResult, ITransportClient} from '@campfirein/brv-transport-client'
import type {Config} from '@oclif/core'

import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import sinon, {restore, stub} from 'sinon'

import SettingsGet from '../../../src/oclif/commands/settings/get.js'
import {SettingsEvents} from '../../../src/shared/transport/events/settings-events.js'

class TestableSettingsGet extends SettingsGet {
  private readonly mockConnector: () => Promise<ConnectionResult>

  public constructor(argv: string[], mockConnector: () => Promise<ConnectionResult>, config: Config) {
    super(argv, config)
    this.mockConnector = mockConnector
  }

  protected override async fetchSetting(key: string) {
    return super.fetchSetting(key, {
      maxRetries: 1,
      retryDelayMs: 0,
      transportConnector: this.mockConnector,
    })
  }
}

/**
 * Smoke coverage for the post-M16.4 surface of `analytics.share`.
 *
 * The wire-shape behaviour, facade routing, and disclosure flow are
 * exercised in depth by:
 *   - test/unit/infra/transport/handlers/settings-handler.test.ts
 *   - test/unit/oclif/lib/analytics-disclosure.test.ts
 *
 * This file only confirms the oclif command path resolves the key to
 * the unified `settings:get` transport event — i.e. the legacy `brv
 * analytics enable / disable` deletion does not leave the value
 * unreachable via the CLI.
 */
describe('brv settings get analytics.share (M16.4 smoke)', () => {
  let config: Config
  let mockClient: sinon.SinonStubbedInstance<ITransportClient>
  let mockConnector: sinon.SinonStub<[], Promise<ConnectionResult>>
  let originalExitCode: number | string | undefined

  before(async () => {
    config = await OclifConfig.load(import.meta.url)
  })

  beforeEach(() => {
    originalExitCode = process.exitCode

    mockClient = {
      connect: stub().resolves(),
      disconnect: stub().resolves(),
      getClientId: stub().returns('test-client-id'),
      getDaemonVersion: stub(),
      getState: stub().returns('connected'),
      isConnected: stub().resolves(true),
      joinRoom: stub().resolves(),
      leaveRoom: stub().resolves(),
      on: stub().returns(() => {}),
      once: stub(),
      onStateChange: stub().returns(() => {}),
      request: stub() as unknown as ITransportClient['request'],
      requestWithAck: stub().resolves({
        category: 'analytics',
        current: false,
        default: false,
        description: 'Send anonymous telemetry to ByteRover.',
        key: 'analytics.share',
        ok: true,
        restartRequired: false,
        type: 'boolean',
      }),
    } as unknown as sinon.SinonStubbedInstance<ITransportClient>

    mockConnector = stub<[], Promise<ConnectionResult>>().resolves({
      client: mockClient as unknown as ITransportClient,
      projectRoot: '/test/project',
    })
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    restore()
  })

  it('routes to the SettingsEvents.GET transport event with key=analytics.share', async () => {
    const command = new TestableSettingsGet(['analytics.share'], mockConnector, config)
    stub(command, 'log').callsFake(() => {})
    await command.run()

    const calls = (mockClient.requestWithAck as sinon.SinonStub).getCalls()
    expect(calls.length, 'one requestWithAck call').to.equal(1)
    expect(calls[0].args[0]).to.equal(SettingsEvents.GET)
    expect(calls[0].args[1]).to.deep.equal({key: 'analytics.share'})
  })
})

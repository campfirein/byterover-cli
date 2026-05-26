import type {ConnectionResult, ITransportClient} from '@campfirein/brv-transport-client'
import type {Config} from '@oclif/core'

import {NoInstanceRunningError} from '@campfirein/brv-transport-client'
import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import sinon, {restore, stub} from 'sinon'

import type {DaemonClientOptions} from '../../../src/oclif/lib/daemon-client.js'
import type {GlobalConfigSetAnalyticsResponse} from '../../../src/shared/transport/events/global-config-events.js'

import Disable from '../../../src/oclif/commands/analytics/disable.js'
import {GlobalConfigEvents} from '../../../src/shared/transport/events/global-config-events.js'

class TestableDisableCommand extends Disable {
  private readonly mockConnector: () => Promise<ConnectionResult>

  constructor(mockConnector: () => Promise<ConnectionResult>, config: Config, argv: string[] = []) {
    super(argv, config)
    this.mockConnector = mockConnector
  }

  protected override async setAnalytics(
    analytics: boolean,
    options?: DaemonClientOptions,
  ): Promise<GlobalConfigSetAnalyticsResponse> {
    return super.setAnalytics(analytics, {
      maxRetries: 1,
      retryDelayMs: 0,
      transportConnector: this.mockConnector,
      ...options,
    })
  }
}

describe('analytics disable command', () => {
  let config: Config
  let loggedMessages: string[]
  let mockClient: sinon.SinonStubbedInstance<ITransportClient>
  let mockConnector: sinon.SinonStub<[], Promise<ConnectionResult>>

  before(async () => {
    config = await OclifConfig.load(import.meta.url)
  })

  beforeEach(() => {
    loggedMessages = []

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
      requestWithAck: stub().resolves({current: false, previous: true}),
    } as unknown as sinon.SinonStubbedInstance<ITransportClient>

    mockConnector = stub<[], Promise<ConnectionResult>>().resolves({
      client: mockClient as unknown as ITransportClient,
      projectRoot: '/test/project',
    })
  })

  afterEach(() => {
    restore()
  })

  function createCommand(argv: string[] = []): TestableDisableCommand {
    const command = new TestableDisableCommand(mockConnector, config, argv)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg) loggedMessages.push(msg)
    })
    return command
  }

  function mockSetAnalyticsResponse(response: GlobalConfigSetAnalyticsResponse): void {
    ;(mockClient.requestWithAck as sinon.SinonStub).resolves(response)
  }

  describe('toggle from enabled to disabled', () => {
    it('should print "Analytics disabled" when previous was true', async () => {
      mockSetAnalyticsResponse({current: false, previous: true})

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Analytics disabled'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('already'))).to.be.false
    })
  })

  describe('idempotent (already disabled)', () => {
    it('should print "Analytics already disabled" when previous equals current', async () => {
      mockSetAnalyticsResponse({current: false, previous: false})

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Analytics already disabled'))).to.be.true
    })
  })

  describe('connection error', () => {
    it('should print formatted connection error when daemon unavailable', async () => {
      mockConnector.rejects(new NoInstanceRunningError())

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Daemon failed to start automatically'))).to.be.true
    })
  })

  describe('transport contract', () => {
    it('should issue exactly one SET_ANALYTICS request with {analytics: false}', async () => {
      mockSetAnalyticsResponse({current: false, previous: true})

      await createCommand().run()

      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      expect(requestStub.callCount).to.equal(1)
      expect(requestStub.firstCall.args[0]).to.equal(GlobalConfigEvents.SET_ANALYTICS)
      expect(requestStub.firstCall.args[1]).to.deep.equal({analytics: false})
    })
  })

  describe('help text', () => {
    it('should declare a description string', () => {
      expect(Disable.description).to.be.a('string').and.not.be.empty
    })
  })
})

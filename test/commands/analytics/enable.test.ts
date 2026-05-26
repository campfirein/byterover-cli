import type {ConnectionResult, ITransportClient} from '@campfirein/brv-transport-client'
import type {Config} from '@oclif/core'

import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import {readFile} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import sinon, {restore, stub} from 'sinon'

import type {DaemonClientOptions} from '../../../src/oclif/lib/daemon-client.js'
import type {
  GlobalConfigGetResponse,
  GlobalConfigSetAnalyticsResponse,
} from '../../../src/shared/transport/events/global-config-events.js'

import Enable from '../../../src/oclif/commands/analytics/enable.js'
import {PRIVACY_POLICY_URL} from '../../../src/shared/constants/privacy.js'
import {GlobalConfigEvents} from '../../../src/shared/transport/events/global-config-events.js'

interface TestHooks {
  confirmCalled?: sinon.SinonStub
  confirmResult?: boolean
  disclosureText?: string
  isTTY?: boolean
}

class TestableEnableCommand extends Enable {
  private readonly mockConnector: () => Promise<ConnectionResult>
  private readonly testHooks: TestHooks

  constructor(
    mockConnector: () => Promise<ConnectionResult>,
    testHooks: TestHooks,
    config: Config,
    argv: string[] = [],
  ) {
    super(argv, config)
    this.mockConnector = mockConnector
    this.testHooks = testHooks
  }

  protected override async confirmDisclosure(): Promise<boolean> {
    this.testHooks.confirmCalled?.()
    return this.testHooks.confirmResult ?? true
  }

  protected override async getCurrentAnalytics(options?: DaemonClientOptions): Promise<boolean> {
    return super.getCurrentAnalytics({
      maxRetries: 1,
      retryDelayMs: 0,
      transportConnector: this.mockConnector,
      ...options,
    })
  }

  protected override isInteractive(): boolean {
    return this.testHooks.isTTY ?? true
  }

  protected override async loadDisclosure(): Promise<string> {
    return this.testHooks.disclosureText ?? 'mock disclosure'
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

describe('analytics enable command (M1.4 disclosure UX)', () => {
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
      requestWithAck: stub(),
    } as unknown as sinon.SinonStubbedInstance<ITransportClient>

    mockConnector = stub<[], Promise<ConnectionResult>>().resolves({
      client: mockClient as unknown as ITransportClient,
      projectRoot: '/test/project',
    })
  })

  afterEach(() => {
    restore()
  })

  function mockGetThenSet(currentAnalytics: boolean, setResponse?: GlobalConfigSetAnalyticsResponse): void {
    const requestStub = mockClient.requestWithAck as sinon.SinonStub
    const getResponse: GlobalConfigGetResponse = {
      analytics: currentAnalytics,
      deviceId: 'test-device',
      version: '1.0.0',
    }
    requestStub.withArgs(GlobalConfigEvents.GET).resolves(getResponse)
    if (setResponse) {
      requestStub.withArgs(GlobalConfigEvents.SET_ANALYTICS).resolves(setResponse)
    }
  }

  function createCommand(testHooks: TestHooks, argv: string[] = []): TestableEnableCommand {
    const command = new TestableEnableCommand(mockConnector, testHooks, config, argv)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg) loggedMessages.push(msg)
    })
    return command
  }

  describe('1. interactive accept flips the flag', () => {
    it('should call SET_ANALYTICS true and print confirmation when user accepts', async () => {
      mockGetThenSet(false, {current: true, previous: false})
      const confirmCalled = stub()

      await createCommand({confirmCalled, confirmResult: true, isTTY: true}).run()

      expect(confirmCalled.calledOnce, 'disclosure prompt should be shown').to.be.true
      expect(loggedMessages.some((m) => m.includes('Analytics enabled'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('not enabled'))).to.be.false

      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      const setCalls = requestStub.getCalls().filter((c) => c.args[0] === GlobalConfigEvents.SET_ANALYTICS)
      expect(setCalls).to.have.lengthOf(1)
      expect(setCalls[0].args[1]).to.deep.equal({analytics: true})
    })
  })

  describe('2. interactive reject leaves flag unchanged', () => {
    it('should NOT call SET_ANALYTICS and print "Analytics not enabled" when user rejects', async () => {
      mockGetThenSet(false)
      const confirmCalled = stub()

      await createCommand({confirmCalled, confirmResult: false, isTTY: true}).run()

      expect(confirmCalled.calledOnce, 'disclosure prompt should be shown').to.be.true
      expect(loggedMessages.some((m) => m.includes('Analytics not enabled'))).to.be.true

      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      const setCalls = requestStub.getCalls().filter((c) => c.args[0] === GlobalConfigEvents.SET_ANALYTICS)
      expect(setCalls, 'no SET_ANALYTICS write should occur on reject').to.have.lengthOf(0)
    })
  })

  describe('3. --yes flag bypasses the prompt', () => {
    it('should flip the flag without showing the disclosure prompt', async () => {
      mockGetThenSet(false, {current: true, previous: false})
      const confirmCalled = stub()

      await createCommand({confirmCalled, confirmResult: true, isTTY: true}, ['--yes']).run()

      expect(confirmCalled.called, 'prompt must NOT be shown when --yes is passed').to.be.false
      expect(loggedMessages.some((m) => m.includes('Analytics enabled'))).to.be.true

      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      const setCalls = requestStub.getCalls().filter((c) => c.args[0] === GlobalConfigEvents.SET_ANALYTICS)
      expect(setCalls).to.have.lengthOf(1)
    })
  })

  describe('4. already-enabled state skips the prompt entirely', () => {
    it('should print "Analytics already enabled" with no prompt and no SET_ANALYTICS call', async () => {
      mockGetThenSet(true)
      const confirmCalled = stub()

      await createCommand({confirmCalled, confirmResult: true, isTTY: true}).run()

      expect(confirmCalled.called, 'prompt must NOT be shown when already enabled').to.be.false
      expect(loggedMessages.some((m) => m.includes('Analytics already enabled'))).to.be.true

      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      const setCalls = requestStub.getCalls().filter((c) => c.args[0] === GlobalConfigEvents.SET_ANALYTICS)
      expect(setCalls, 'no SET_ANALYTICS write when already enabled').to.have.lengthOf(0)
    })
  })

  describe('5. non-TTY without --yes refuses with clear error', () => {
    it('should exit non-zero and print a clear error directing the user to --yes', async () => {
      mockGetThenSet(false)
      const confirmCalled = stub()

      const command = createCommand({confirmCalled, confirmResult: true, isTTY: false})
      const errorStub = stub(command, 'error').throws(new Error('non-interactive refusal'))

      let caught: unknown
      try {
        await command.run()
      } catch (error) {
        caught = error
      }

      expect(caught, 'this.error must be invoked when stdin is non-TTY without --yes').to.be.instanceOf(Error)
      expect(errorStub.calledOnce).to.be.true
      const errorMessage = errorStub.firstCall.args[0]
      expect(errorMessage).to.be.a('string').and.to.match(/--yes|non-interactive|interactive/i)
      expect(confirmCalled.called, 'prompt must NOT be shown in non-TTY').to.be.false

      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      const setCalls = requestStub.getCalls().filter((c) => c.args[0] === GlobalConfigEvents.SET_ANALYTICS)
      expect(setCalls, 'no SET_ANALYTICS write when refusing').to.have.lengthOf(0)
    })
  })

  describe('6. disclosure markdown contains all required sections', () => {
    it('should include the five required sections plus the privacy policy link', async () => {
      const here = dirname(fileURLToPath(import.meta.url))
      const disclosurePath = resolve(here, '../../../src/server/templates/sections/analytics-disclosure.md')
      const text = await readFile(disclosurePath, 'utf8')

      expect(text, 'what-is-collected section').to.match(/what is collected/i)
      expect(text, 'which-surfaces section').to.match(/which surfaces|surfaces are tracked/i)
      expect(text, 'where-it-goes section').to.match(/where (it )?goes/i)
      expect(text, 'cross-device alias section').to.match(/cross-device|alias/i)
      expect(text, 'how-to-disable section').to.match(/how to disable|brv analytics disable/i)
      expect(text, 'privacy policy link').to.include(PRIVACY_POLICY_URL)
    })
  })

  describe('7. privacy policy URL constant', () => {
    it('should be a non-empty https URL', () => {
      expect(PRIVACY_POLICY_URL).to.be.a('string').and.not.be.empty
      expect(PRIVACY_POLICY_URL).to.match(/^https:\/\//)
    })
  })

  describe('help text', () => {
    it('should declare a non-empty description string', () => {
      expect(Enable.description).to.be.a('string').and.not.be.empty
    })
  })
})

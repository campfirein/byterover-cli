import type {ConnectionResult, ITransportClient} from '@campfirein/brv-transport-client'
import type {Config} from '@oclif/core'

import {NoInstanceRunningError} from '@campfirein/brv-transport-client'
import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import sinon, {restore, stub} from 'sinon'

import type {DaemonClientOptions} from '../../../src/oclif/lib/daemon-client.js'
import type {AnalyticsStatusResponse} from '../../../src/shared/transport/events/analytics-events.js'

/* eslint-disable camelcase -- JSON wire shape is snake_case per the M4.6 ticket schema. */
import Status from '../../../src/oclif/commands/analytics/status.js'
import {AnalyticsEvents} from '../../../src/shared/transport/events/analytics-events.js'

/**
 * M4.6 test surface: the command issues a single `analytics:status`
 * request to the daemon and renders the response as text or JSON. The
 * mock here returns shapes that exercise each branch of the renderer.
 */
class TestableStatusCommand extends Status {
  private readonly mockConnector: () => Promise<ConnectionResult>

  constructor(mockConnector: () => Promise<ConnectionResult>, config: Config, argv: string[] = []) {
    super(argv, config)
    this.mockConnector = mockConnector
  }

  protected override async fetchAnalyticsStatus(options?: DaemonClientOptions): Promise<AnalyticsStatusResponse> {
    return super.fetchAnalyticsStatus({
      maxRetries: 1,
      retryDelayMs: 0,
      transportConnector: this.mockConnector,
      ...options,
    })
  }

  // M4.6: pin the clock so "Xm ago" assertions are deterministic.
  protected override now(): number {
    return 1_700_000_000_000
  }
}

const HEALTHY_RESPONSE: AnalyticsStatusResponse = {
  backoff: {consecutiveFailures: 0, nextDelayMs: 30_000, state: 'healthy'},
  droppedCount: 0,
  enabled: true,
  endpoint: 'https://telemetry-dev.byterover.dev',
  queueDepth: 4,
}

describe('analytics status command (M4.6)', () => {
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
      requestWithAck: stub().resolves(HEALTHY_RESPONSE),
    } as unknown as sinon.SinonStubbedInstance<ITransportClient>

    mockConnector = stub<[], Promise<ConnectionResult>>().resolves({
      client: mockClient as unknown as ITransportClient,
      projectRoot: '/test/project',
    })
  })

  afterEach(() => {
    restore()
  })

  function createCommand(argv: string[] = []): TestableStatusCommand {
    const command = new TestableStatusCommand(mockConnector, config, argv)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg !== undefined) loggedMessages.push(msg)
    })
    return command
  }

  function mockStatusResponse(response: AnalyticsStatusResponse): void {
    ;(mockClient.requestWithAck as sinon.SinonStub).resolves(response)
  }

  function captureJson(argv: string[] = ['--format', 'json']): Promise<{captured: string}> {
    return new Promise((resolve) => {
      let captured = ''
      const writeStub = stub(process.stdout, 'write').callsFake((chunk) => {
        captured += chunk
        return true
      })

      new TestableStatusCommand(mockConnector, config, argv).run().finally(() => {
        writeStub.restore()
        resolve({captured})
      }).catch(() => {
        // The .finally above already resolves the outer promise; the
        // .catch here keeps lint happy about an unhandled rejection on
        // the underlying chain (the renderer never throws — error paths
        // write a JSON error envelope and return).
      })
    })
  }

  describe('text output', () => {
    it('disabled state: only shows "disabled" (other fields suppressed)', async () => {
      mockStatusResponse({...HEALTHY_RESPONSE, enabled: false})

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Analytics: disabled'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('Queue depth'))).to.be.false
      expect(loggedMessages.some((m) => m.includes('Backoff state'))).to.be.false
      expect(loggedMessages.some((m) => m.includes('Endpoint'))).to.be.false
    })

    it('enabled, never flushed: "Last successful flush: never"', async () => {
      mockStatusResponse({...HEALTHY_RESPONSE, lastFlushAt: undefined})

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Analytics: enabled'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('Last successful flush: never'))).to.be.true
    })

    it('enabled, flushed 5 minutes ago: ISO timestamp with relative time', async () => {
      // Pinned `now()` = 1_700_000_000_000 → ISO 2023-11-14T22:13:20.000Z.
      // lastFlushAt 5 minutes earlier.
      const fiveMinutesAgo = 1_700_000_000_000 - 5 * 60_000
      mockStatusResponse({...HEALTHY_RESPONSE, lastFlushAt: fiveMinutesAgo})

      await createCommand().run()

      const flushLine = loggedMessages.find((m) => m.includes('Last successful flush'))
      expect(flushLine, 'flush line present').to.not.equal(undefined)
      expect(flushLine, 'shows ISO timestamp').to.include('2023-11-14T22:08:20')
      expect(flushLine, 'shows relative time').to.include('(5m ago)')
    })

    it('"just now" for sub-minute deltas', async () => {
      mockStatusResponse({...HEALTHY_RESPONSE, lastFlushAt: 1_700_000_000_000 - 30_000})

      await createCommand().run()

      const flushLine = loggedMessages.find((m) => m.includes('Last successful flush'))
      expect(flushLine).to.include('(just now)')
    })

    it('hours-then-days relative formatting', async () => {
      mockStatusResponse({...HEALTHY_RESPONSE, lastFlushAt: 1_700_000_000_000 - 3 * 60 * 60_000})
      await createCommand().run()
      expect(loggedMessages.find((m) => m.includes('Last successful flush'))).to.include('(3h ago)')

      loggedMessages.length = 0
      mockStatusResponse({...HEALTHY_RESPONSE, lastFlushAt: 1_700_000_000_000 - 2 * 24 * 60 * 60_000})
      await createCommand().run()
      expect(loggedMessages.find((m) => m.includes('Last successful flush'))).to.include('(2d ago)')
    })

    it('backoff state "degraded": shows label + consecutive failures + next delay', async () => {
      mockStatusResponse({
        ...HEALTHY_RESPONSE,
        backoff: {consecutiveFailures: 2, nextDelayMs: 120_000, state: 'degraded'},
      })

      await createCommand().run()

      const backoffLine = loggedMessages.find((m) => m.toLowerCase().includes('backoff'))
      expect(backoffLine).to.include('degraded')
      expect(backoffLine).to.include('2')
      expect(backoffLine).to.include('120000')
    })

    it('endpoint not configured: shows literal placeholder', async () => {
      mockStatusResponse({
        ...HEALTHY_RESPONSE,
        backoff: {consecutiveFailures: 0, nextDelayMs: 30_000, state: 'unreachable'},
        endpoint: '(not configured)',
      })

      await createCommand().run()

      const endpointLine = loggedMessages.find((m) => m.includes('Endpoint'))
      expect(endpointLine).to.include('(not configured)')
      const backoffLine = loggedMessages.find((m) => m.toLowerCase().includes('backoff'))
      expect(backoffLine, 'overridden to unreachable').to.include('unreachable')
    })

    it('shows queue depth and dropped events on enabled state', async () => {
      mockStatusResponse({...HEALTHY_RESPONSE, droppedCount: 7, queueDepth: 12})

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Queue depth: 12 events'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('Dropped events') && m.includes('7'))).to.be.true
    })
  })

  describe('JSON output', () => {
    it('emits the documented snake_case schema on enabled state', async () => {
      const flushAt = 1_700_000_000_000 - 5 * 60_000
      mockStatusResponse({...HEALTHY_RESPONSE, lastFlushAt: flushAt})

      const {captured} = await captureJson()
      const parsed = JSON.parse(captured) as {
        data: {
          backoff: {consecutive_failures: number; next_delay_ms: number; state: string}
          dropped_events: number
          enabled: boolean
          endpoint: string
          last_flush: null | string
          queue_depth: number
        }
        success: boolean
      }

      expect(parsed.success).to.equal(true)
      expect(parsed.data.enabled).to.equal(true)
      expect(parsed.data.last_flush, 'ISO 8601 string').to.equal(new Date(flushAt).toISOString())
      expect(parsed.data.queue_depth).to.equal(4)
      expect(parsed.data.dropped_events).to.equal(0)
      expect(parsed.data.backoff).to.deep.equal({consecutive_failures: 0, next_delay_ms: 30_000, state: 'healthy'})
      expect(parsed.data.endpoint).to.equal('https://telemetry-dev.byterover.dev')
    })

    it('emits last_flush: null when never flushed', async () => {
      mockStatusResponse({...HEALTHY_RESPONSE, lastFlushAt: undefined})

      const {captured} = await captureJson()
      const parsed = JSON.parse(captured) as {data: {last_flush: null | string}}
      expect(parsed.data.last_flush).to.equal(null)
    })

    it('keeps stable shape on disabled state (full fields present)', async () => {
      mockStatusResponse({...HEALTHY_RESPONSE, enabled: false})

      const {captured} = await captureJson()
      const parsed = JSON.parse(captured) as {data: Record<string, unknown>}
      expect(parsed.data.enabled).to.equal(false)
      // Ticket schema: shape doesn't depend on enabled flag.
      expect(parsed.data).to.have.all.keys('backoff', 'dropped_events', 'enabled', 'endpoint', 'last_flush', 'queue_depth')
    })

    it('returns success=false on connection error', async () => {
      mockConnector.rejects(new NoInstanceRunningError())

      const {captured} = await captureJson()
      const parsed = JSON.parse(captured) as {success: boolean}
      expect(parsed.success).to.equal(false)
    })
  })

  describe('transport contract', () => {
    it('issues exactly one request against AnalyticsEvents.STATUS', async () => {
      mockStatusResponse(HEALTHY_RESPONSE)

      await createCommand().run()

      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      expect(requestStub.callCount).to.equal(1)
      expect(requestStub.firstCall.args[0]).to.equal(AnalyticsEvents.STATUS)
    })
  })

  describe('help text', () => {
    it('declares a description string and does not throw on construction', () => {
      expect(Status.description).to.be.a('string').and.not.be.empty
    })
  })
})

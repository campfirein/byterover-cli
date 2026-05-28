/* eslint-disable camelcase */
import {expect} from 'chai'

import type {IAnalyticsClient} from '../../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'
import type {AnalyticsEventName} from '../../../../../../src/shared/analytics/event-names.js'
import type {PropsArg} from '../../../../../../src/shared/analytics/events/index.js'

import {AnalyticsBatch} from '../../../../../../src/server/core/domain/analytics/batch.js'
import {AnalyticsHandler} from '../../../../../../src/server/infra/transport/handlers/analytics-handler.js'
import {AnalyticsEventNames} from '../../../../../../src/shared/analytics/event-names.js'
import {AnalyticsEvents, type AnalyticsTrackPayload} from '../../../../../../src/shared/transport/events/analytics-events.js'
import {createMockTransportServer} from '../../../../../helpers/mock-factories.js'

type AnalyticsTrackHandler = (data: unknown, clientId: string) => Promise<void>

type TrackCall = {event: AnalyticsEventName; properties: unknown}

type MockAnalyticsClient = IAnalyticsClient & {
  readonly trackCalls: readonly TrackCall[]
  trackThrows?: Error
}

/**
 * Hand-rolled mock that preserves the generic signature on `track`. Sinon's
 * `stub()` collapses generics into a single SinonStub overload, which fails
 * to satisfy `IAnalyticsClient.track<E extends AnalyticsEventName>`.
 */
function makeMockAnalyticsClient(): MockAnalyticsClient {
  const trackCalls: TrackCall[] = []
  const mock: MockAnalyticsClient = {
    abort() {
      /* M4.4: not exercised in this test */
    },
    flush: () => Promise.resolve(AnalyticsBatch.create([])),
    getRuntimeState: () => Promise.resolve({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
    onAuthTransition: () => Promise.resolve(),
    track<E extends AnalyticsEventName>(event: E, ...rest: PropsArg<E>): void {
      if (mock.trackThrows) throw mock.trackThrows
      const [properties] = rest
      trackCalls.push({event, properties})
    },
    trackCalls,
  }
  return mock
}

describe('AnalyticsHandler', () => {
  it('should register a handler for analytics:track on setup()', () => {
    const transport = createMockTransportServer()
    const analyticsClient = makeMockAnalyticsClient()

    new AnalyticsHandler({analyticsClient, transport}).setup()

    expect(transport._handlers.has(AnalyticsEvents.TRACK)).to.equal(true)
  })

  describe('per-event Zod validation + typed dispatch', () => {
    it('should route a valid known event + valid properties to analyticsClient.track', async () => {
      const transport = createMockTransportServer()
      const analyticsClient = makeMockAnalyticsClient()
      new AnalyticsHandler({analyticsClient, transport}).setup()

      const handler = transport._handlers.get(AnalyticsEvents.TRACK) as AnalyticsTrackHandler
      const payload: AnalyticsTrackPayload = {
        event: AnalyticsEventNames.CURATE_OPERATION_APPLIED,
        properties: {
          keywords: [],
          knowledge_path: 'kg/a.md',
          needs_review: false,
          operation_type: 'ADD',
          relative_path: 'tmp/a.md',
          tags: [],
          task_id: 't-1',
        },
      }
      await handler(payload, 'client-1')

      expect(analyticsClient.trackCalls).to.have.lengthOf(1)
      expect(analyticsClient.trackCalls[0].event).to.equal(AnalyticsEventNames.CURATE_OPERATION_APPLIED)
      expect(analyticsClient.trackCalls[0].properties).to.deep.equal({
        keywords: [],
        knowledge_path: 'kg/a.md',
        needs_review: false,
        operation_type: 'ADD',
        relative_path: 'tmp/a.md',
        tags: [],
        task_id: 't-1',
      })
    })

    it('should route DAEMON_START (no required properties) without forwarding props', async () => {
      const transport = createMockTransportServer()
      const analyticsClient = makeMockAnalyticsClient()
      new AnalyticsHandler({analyticsClient, transport}).setup()

      const handler = transport._handlers.get(AnalyticsEvents.TRACK) as AnalyticsTrackHandler
      await handler({event: AnalyticsEventNames.DAEMON_START}, 'client-1')

      expect(analyticsClient.trackCalls).to.have.lengthOf(1)
      expect(analyticsClient.trackCalls[0].event).to.equal(AnalyticsEventNames.DAEMON_START)
      // PropsArg makes properties absent for events with no required props.
      expect(analyticsClient.trackCalls[0].properties).to.equal(undefined)
    })

    it('should drop UNKNOWN event names silently (no track call)', async () => {
      const transport = createMockTransportServer()
      const analyticsClient = makeMockAnalyticsClient()
      new AnalyticsHandler({analyticsClient, transport}).setup()

      const handler = transport._handlers.get(AnalyticsEvents.TRACK) as AnalyticsTrackHandler
      await handler({event: 'cli_invocation', properties: {x: 1}}, 'client-1')
      await handler({event: 'mystery_event'}, 'client-1')

      expect(analyticsClient.trackCalls, 'unknown events must NOT reach track').to.deep.equal([])
    })

    it('should drop KNOWN events with INVALID per-event properties silently', async () => {
      const transport = createMockTransportServer()
      const analyticsClient = makeMockAnalyticsClient()
      new AnalyticsHandler({analyticsClient, transport}).setup()

      const handler = transport._handlers.get(AnalyticsEvents.TRACK) as AnalyticsTrackHandler
      // CURATE_OPERATION_APPLIED requires relative_path / knowledge_path / etc.
      await handler({event: AnalyticsEventNames.CURATE_OPERATION_APPLIED, properties: {wrong: 'shape'}}, 'client-1')
      // QUERY_COMPLETED requires duration_ms / outcome / etc.
      await handler({event: AnalyticsEventNames.QUERY_COMPLETED, properties: {}}, 'client-1')

      expect(analyticsClient.trackCalls, 'invalid per-event props must NOT reach track').to.deep.equal([])
    })
  })

  it('should drop invalid wire envelope silently (no throw, no track call)', async () => {
    const transport = createMockTransportServer()
    const analyticsClient = makeMockAnalyticsClient()
    new AnalyticsHandler({analyticsClient, transport}).setup()

    const handler = transport._handlers.get(AnalyticsEvents.TRACK) as AnalyticsTrackHandler

    await handler({event: ''}, 'client-1')
    await handler({properties: {x: 1}}, 'client-1')
    await handler({event: 42}, 'client-1')
    await handler(null, 'client-1')

    expect(analyticsClient.trackCalls, 'track must NOT be called for invalid envelopes').to.deep.equal([])
  })

  it('should not throw when analyticsClient.track itself throws', async () => {
    const transport = createMockTransportServer()
    const analyticsClient = makeMockAnalyticsClient()
    analyticsClient.trackThrows = new Error('boom')
    new AnalyticsHandler({analyticsClient, transport}).setup()

    const handler = transport._handlers.get(AnalyticsEvents.TRACK) as AnalyticsTrackHandler

    let caught: unknown
    try {
      await handler({event: AnalyticsEventNames.DAEMON_START}, 'client-1')
    } catch (error) {
      caught = error
    }

    expect(caught, 'handler must NOT propagate track() errors').to.equal(undefined)
  })

  /**
   * Regression coverage for every per-event `case` branch in `dispatch()`.
   * The base tests above cover the dispatch PATTERN via one sample event;
   * if a future refactor drops a `case` branch the event would fall
   * through silently (no error, no track call). This parameterized test
   * exercises every catalog event with a minimal valid payload and asserts
   * the dispatch reaches `track()`.
   */
  describe('per-event dispatch coverage — every new event name reaches track()', () => {
    const validHashHex = 'a'.repeat(64)
    // Per-event minimal payloads that satisfy each schema. Lifecycle events
    // (34 of 37) carry `outcome: 'success'`; 3 observation events stay
    // outcome-less. Payloads are intentionally narrow — broader fixture
    // coverage lives in privacy-fixture.test.ts.
    const cases: Array<{event: AnalyticsEventName; properties?: Record<string, unknown>}> = [
      {event: AnalyticsEventNames.ANALYTICS_DISABLED, properties: {}},
      {event: AnalyticsEventNames.AUTH_LOGIN, properties: {outcome: 'success'}},
      {event: AnalyticsEventNames.AUTH_LOGOUT, properties: {outcome: 'success'}},
      {
        event: AnalyticsEventNames.BRV_INIT,
        properties: {had_existing_brv_dir: false, outcome: 'success', project_path_hash: validHashHex},
      },
      {
        event: AnalyticsEventNames.CONNECTOR_INSTALLED,
        properties: {agent_target: 'claude-code', connector_id: 'rules', outcome: 'success'},
      },
      {
        event: AnalyticsEventNames.CONTEXT_TREE_FILE_EDITED,
        properties: {
          file_relative_path_hash: validHashHex,
          outcome: 'success',
          project_path_hash: validHashHex,
        },
      },
      {event: AnalyticsEventNames.DAEMON_RESET_EXECUTED, properties: {outcome: 'success', reset_scope: 'project'}},
      {
        event: AnalyticsEventNames.HUB_PACKAGE_INSTALLED,
        properties: {outcome: 'success', package_identifier: 'team/space'},
      },
      {
        event: AnalyticsEventNames.HUB_REGISTRY_ADDED,
        properties: {is_default: true, outcome: 'success', registry_kind: 'byterover'},
      },
      {event: AnalyticsEventNames.HUB_REGISTRY_REMOVED, properties: {outcome: 'success', registry_kind: 'byterover'}},
      {
        event: AnalyticsEventNames.MIGRATE_RUN,
        properties: {dry_run: false, mode: 'forward', outcome: 'success'},
      },
      {event: AnalyticsEventNames.ONBOARDING_AUTO_SETUP_STARTED, properties: {mode: 'auto', outcome: 'success'}},
      {event: AnalyticsEventNames.ONBOARDING_COMPLETED, properties: {outcome: 'success'}},
      {
        event: AnalyticsEventNames.REVIEW_APPROVED,
        properties: {operation_kind: 'add', outcome: 'success', project_path_hash: validHashHex},
      },
      {
        event: AnalyticsEventNames.REVIEW_REJECTED,
        properties: {operation_kind: 'add', outcome: 'success', project_path_hash: validHashHex},
      },
      {
        event: AnalyticsEventNames.REVIEW_TOGGLED,
        properties: {outcome: 'success', project_path_hash: validHashHex},
      },
      {
        event: AnalyticsEventNames.SETTING_CHANGED,
        properties: {outcome: 'success', setting_key: 'agentPool.maxSize', value_kind: 'integer'},
      },
      {
        event: AnalyticsEventNames.SETTING_RESET,
        properties: {outcome: 'success', setting_key: 'agentPool.maxSize', value_kind: 'integer'},
      },
      {
        event: AnalyticsEventNames.SOURCE_ADDED,
        properties: {outcome: 'success', project_path_hash: validHashHex},
      },
      {event: AnalyticsEventNames.SOURCE_REMOVED, properties: {outcome: 'success', project_path_hash: validHashHex}},
      {
        event: AnalyticsEventNames.SPACE_SWITCHED,
        properties: {from_space_id: 'a', outcome: 'success'},
      },
      {event: AnalyticsEventNames.VC_BRANCHED, properties: {outcome: 'success', project_path_hash: validHashHex}},
      {event: AnalyticsEventNames.VC_CHECKED_OUT, properties: {outcome: 'success', project_path_hash: validHashHex}},
      {
        event: AnalyticsEventNames.VC_CLONED,
        properties: {outcome: 'success', remote_kind: 'byterover'},
      },
      {
        event: AnalyticsEventNames.VC_COMMIT,
        properties: {had_message: true, outcome: 'success', project_path_hash: validHashHex},
      },
      {
        event: AnalyticsEventNames.VC_DISCARDED,
        properties: {discard_scope: 'file', outcome: 'success', project_path_hash: validHashHex},
      },
      {
        event: AnalyticsEventNames.VC_FETCHED,
        properties: {outcome: 'success', project_path_hash: validHashHex, remote_kind: 'byterover'},
      },
      {
        event: AnalyticsEventNames.VC_INIT,
        properties: {had_existing_git_dir: false, outcome: 'success', project_path_hash: validHashHex},
      },
      {
        event: AnalyticsEventNames.VC_MERGED,
        properties: {outcome: 'success', project_path_hash: validHashHex},
      },
      {
        event: AnalyticsEventNames.VC_PULLED,
        properties: {
          branch_name_hash: validHashHex,
          outcome: 'success',
          project_path_hash: validHashHex,
          remote_kind: 'byterover',
        },
      },
      {
        event: AnalyticsEventNames.VC_PUSHED,
        properties: {
          branch_name_hash: validHashHex,
          outcome: 'success',
          project_path_hash: validHashHex,
          remote_kind: 'byterover',
        },
      },
      {
        event: AnalyticsEventNames.VC_REMOTE_CHANGED,
        properties: {
          change_kind: 'added',
          outcome: 'success',
          project_path_hash: validHashHex,
          remote_kind: 'byterover',
        },
      },
      {
        event: AnalyticsEventNames.VC_RESET_EXECUTED,
        properties: {outcome: 'success', project_path_hash: validHashHex, reset_mode: 'soft'},
      },
      {
        event: AnalyticsEventNames.WEBUI_SESSION_ENDED,
        properties: {session_duration_ms: 5000, started_at_unix_ms: 1_700_000_000_000},
      },
      {event: AnalyticsEventNames.WEBUI_SESSION_STARTED, properties: {started_at_unix_ms: 1_700_000_000_000}},
      {
        event: AnalyticsEventNames.WORKTREE_ADDED,
        properties: {outcome: 'success', project_path_hash: validHashHex},
      },
      {event: AnalyticsEventNames.WORKTREE_REMOVED, properties: {outcome: 'success', project_path_hash: validHashHex}},
    ]

    for (const {event, properties} of cases) {
      it(`dispatches ${event} to analyticsClient.track`, async () => {
        const transport = createMockTransportServer()
        const analyticsClient = makeMockAnalyticsClient()
        new AnalyticsHandler({analyticsClient, transport}).setup()

        const handler = transport._handlers.get(AnalyticsEvents.TRACK) as AnalyticsTrackHandler
        await handler({event, properties}, 'client-1')

        const calls = analyticsClient.trackCalls.filter((c) => c.event === event)
        expect(calls.length, `dispatch case missing or dropped for ${event}`).to.equal(1)
      })
    }

    it('coverage matches schema count (37 new events covered)', () => {
      expect(cases.length, 'must enumerate all 37 new event names').to.equal(37)
    })
  })
})

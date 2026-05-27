import type {AnalyticsEventName} from '../../../../shared/analytics/event-names.js'
import type {PropsArg} from '../../../../shared/analytics/events/index.js'
import type {IAnalyticsClient} from '../../../core/interfaces/analytics/i-analytics-client.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {AnalyticsEventNames} from '../../../../shared/analytics/event-names.js'
import {
  type SourceAddRequest,
  type SourceAddResponse,
  SourceEvents,
  type SourceListRequest,
  type SourceListResponse,
  type SourceRemoveRequest,
  type SourceRemoveResponse,
} from '../../../../shared/transport/events/source-events.js'
import {addSource, listSourceStatuses, removeSource} from '../../../core/domain/source/source-operations.js'
import {hashProjectPath} from '../../../utils/hash-path.js'
import {processLog} from '../../../utils/process-logger.js'
import {type ProjectPathResolver, resolveRequiredProjectPath} from './handler-types.js'

export interface SourceHandlerDeps {
  analyticsClient?: IAnalyticsClient
  resolveProjectPath: ProjectPathResolver
  transport: ITransportServer
}

export class SourceHandler {
  private readonly analyticsClient: IAnalyticsClient | undefined
  private readonly resolveProjectPath: ProjectPathResolver
  private readonly transport: ITransportServer

  constructor(deps: SourceHandlerDeps) {
    this.analyticsClient = deps.analyticsClient
    this.resolveProjectPath = deps.resolveProjectPath
    this.transport = deps.transport
  }

  setup(): void {
    this.transport.onRequest<SourceAddRequest, SourceAddResponse>(
      SourceEvents.ADD,
      async (data, clientId) => {
        const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
        const result = addSource(projectPath, data.targetPath, data.alias)
        /* eslint-disable camelcase */
        this.emitAnalytics(AnalyticsEventNames.SOURCE_ADDED, {
          ...(result.success ? {} : {failure_kind: 'add_failed'}),
          outcome: result.success ? 'success' : 'failure',
          project_path_hash: hashProjectPath(projectPath),
          ...(result.success ? {source_origin_hash: hashProjectPath(data.targetPath)} : {}),
        })
        /* eslint-enable camelcase */
        return {
          message: result.message,
          success: result.success,
        }
      },
    )

    this.transport.onRequest<SourceRemoveRequest, SourceRemoveResponse>(
      SourceEvents.REMOVE,
      async (data, clientId) => {
        const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
        const result = removeSource(projectPath, data.aliasOrPath)
        /* eslint-disable camelcase */
        this.emitAnalytics(AnalyticsEventNames.SOURCE_REMOVED, {
          ...(result.success ? {} : {failure_kind: 'remove_failed'}),
          outcome: result.success ? 'success' : 'failure',
          project_path_hash: hashProjectPath(projectPath),
        })
        /* eslint-enable camelcase */
        return {
          message: result.message,
          success: result.success,
        }
      },
    )

    this.transport.onRequest<SourceListRequest, SourceListResponse>(
      SourceEvents.LIST,
      async (_data, clientId) => {
        const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
        const result = listSourceStatuses(projectPath)
        return {
          error: result.error,
          statuses: result.statuses,
        }
      },
    )
  }

  /**
   * Analytics emit helper. Mirrors the try/processLog pattern from other
   * handlers so analytics failures never affect command outcomes.
   */
  private emitAnalytics<E extends AnalyticsEventName>(event: E, ...rest: PropsArg<E>): void {
    const client = this.analyticsClient
    if (!client) return
    try {
      client.track(event, ...rest)
    } catch (error) {
      processLog(`[Source] analytics track ${event} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

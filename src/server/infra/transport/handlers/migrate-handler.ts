/**
 * Handler for migrate:* events.
 *
 * Thin wrapper over `runMigration` / `rollback`. Pure local-disk work
 * — no auth, no LLM, no remote calls. NOT concurrency-safe with
 * `brv curate` / `brv dream`: the operator must avoid running those
 * concurrently. See `src/oclif/commands/migrate.ts` help text.
 *
 * The projectRoot is resolved from the registered clientId via the
 * shared `ProjectPathResolver` — the request payload never carries a
 * client-supplied path. Matches the convention used by ResetHandler,
 * VcHandler, PushHandler, etc.
 */

/* eslint-disable camelcase */
import type {
  MigrateRollbackRequest,
  MigrateRollbackResponse,
  MigrateRunRequest,
  MigrateRunResponse,
} from '../../../../shared/transport/events/migrate-events.js'
import type {IAnalyticsClient} from '../../../core/interfaces/analytics/i-analytics-client.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {AnalyticsEventNames} from '../../../../shared/analytics/event-names.js'
import {type MigrateRunProps} from '../../../../shared/analytics/events/migrate-run.js'
import {MigrateEvents} from '../../../../shared/transport/events/migrate-events.js'
import {processLog} from '../../../utils/process-logger.js'
import {rollback, runMigration} from '../../migrate/orchestrator.js'
import {type ProjectPathResolver, resolveRequiredProjectPath} from './handler-types.js'

export interface MigrateHandlerDeps {
  readonly analyticsClient?: IAnalyticsClient
  resolveProjectPath: ProjectPathResolver
  transport: ITransportServer
}

export class MigrateHandler {
  private readonly analyticsClient: IAnalyticsClient | undefined
  private readonly resolveProjectPath: ProjectPathResolver
  private readonly transport: ITransportServer

  constructor(deps: MigrateHandlerDeps) {
    this.analyticsClient = deps.analyticsClient
    this.resolveProjectPath = deps.resolveProjectPath
    this.transport = deps.transport
  }

  setup(): void {
    this.transport.onRequest<MigrateRunRequest, MigrateRunResponse>(
      MigrateEvents.RUN,
      (data, clientId) => this.handleRun(data, clientId),
    )
    this.transport.onRequest<MigrateRollbackRequest, MigrateRollbackResponse>(
      MigrateEvents.ROLLBACK,
      (data, clientId) => this.handleRollback(data, clientId),
    )
  }

  /**
   * Analytics emit helper. Mirrors the try/processLog pattern from
   * SettingsHandler so analytics failures never affect command outcomes.
   */
  private emitMigrateRun(properties: MigrateRunProps): void {
    const client = this.analyticsClient
    if (!client) return
    try {
      client.track(AnalyticsEventNames.MIGRATE_RUN, properties)
    } catch (error) {
      processLog(
        `[Migrate] analytics track migrate_run failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private async handleRollback(
    data: MigrateRollbackRequest,
    clientId: string,
  ): Promise<MigrateRollbackResponse> {
    const projectRoot = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    try {
      const report = rollback({dryRun: data.dryRun, projectRoot})
      this.emitMigrateRun({
        deleted_html: report.deletedHtml.length,
        dry_run: report.dryRun,
        mode: 'rollback',
        outcome: 'success',
        preserved_html: report.preservedHtml.length,
        restored: report.restored,
      })
      return report
    } catch (error) {
      this.emitMigrateRun({
        dry_run: data.dryRun,
        failure_kind: classifyMigrateFailure(error),
        mode: 'rollback',
        outcome: 'failure',
      })
      throw error
    }
  }

  private async handleRun(
    data: MigrateRunRequest,
    clientId: string,
  ): Promise<MigrateRunResponse> {
    const projectRoot = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    try {
      const report = runMigration({dryRun: data.dryRun, projectRoot})
      this.emitMigrateRun({
        archived: report.summary.archived,
        dry_run: report.dryRun,
        failed: report.summary.failed,
        migrated: report.summary.migrated,
        mode: 'forward',
        outcome: 'success',
        skipped: report.summary.skipped,
      })
      return {report}
    } catch (error) {
      this.emitMigrateRun({
        dry_run: data.dryRun,
        failure_kind: classifyMigrateFailure(error),
        mode: 'forward',
        outcome: 'failure',
      })
      throw error
    }
  }
}

function classifyMigrateFailure(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message
    if (msg.startsWith('Migration already ran today')) return 'archive_exists'
    if (msg.startsWith('No archive to roll back')) return 'no_archive'
  }

  return 'unknown'
}

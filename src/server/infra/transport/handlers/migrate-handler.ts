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

import type {
  MigrateRollbackRequest,
  MigrateRollbackResponse,
  MigrateRunRequest,
  MigrateRunResponse,
} from '../../../../shared/transport/events/migrate-events.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {MigrateEvents} from '../../../../shared/transport/events/migrate-events.js'
import {rollback, runMigration} from '../../migrate/orchestrator.js'
import {type ProjectPathResolver, resolveRequiredProjectPath} from './handler-types.js'

export interface MigrateHandlerDeps {
  resolveProjectPath: ProjectPathResolver
  transport: ITransportServer
}

export class MigrateHandler {
  private readonly resolveProjectPath: ProjectPathResolver
  private readonly transport: ITransportServer

  constructor(deps: MigrateHandlerDeps) {
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

  private async handleRollback(
    data: MigrateRollbackRequest,
    clientId: string,
  ): Promise<MigrateRollbackResponse> {
    const projectRoot = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    return rollback({dryRun: data.dryRun, projectRoot})
  }

  private async handleRun(
    data: MigrateRunRequest,
    clientId: string,
  ): Promise<MigrateRunResponse> {
    const projectRoot = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const report = runMigration({dryRun: data.dryRun, projectRoot})
    return {report}
  }
}

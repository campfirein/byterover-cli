import {readFile} from 'node:fs/promises'
import {join} from 'node:path'

import type {StatusDTO} from '../../../../shared/transport/types/dto.js'
import type {ITokenStore} from '../../../core/interfaces/auth/i-token-store.js'
import type {IContextTreeService} from '../../../core/interfaces/context-tree/i-context-tree-service.js'
import type {IContextTreeSnapshotService} from '../../../core/interfaces/context-tree/i-context-tree-snapshot-service.js'
import type {IProviderConfigStore} from '../../../core/interfaces/i-provider-config-store.js'
import type {IBillingService} from '../../../core/interfaces/services/i-billing-service.js'
import type {IAuthStateStore} from '../../../core/interfaces/state/i-auth-state-store.js'
import type {IBillingConfigStore} from '../../../core/interfaces/storage/i-billing-config-store.js'
import type {ICurateLogStore} from '../../../core/interfaces/storage/i-curate-log-store.js'
import type {IProjectConfigStore} from '../../../core/interfaces/storage/i-project-config-store.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {StatusEvents, type StatusGetRequest, type StatusGetResponse} from '../../../../shared/transport/events/status-events.js'
import {BRV_DIR, CONTEXT_TREE_DIR} from '../../../constants.js'
import {listSourceStatuses} from '../../../core/domain/source/source-operations.js'
import {buildReviewUrl} from '../../../utils/build-review-url.js'
import {resolveBillingForProject} from '../../billing/resolve-billing-source.js'
import {BrokenWorktreePointerError, MalformedWorktreePointerError, resolveProject} from '../../project/resolve-project.js'
import {type ProjectPathResolver, resolveRequiredProjectPath} from './handler-types.js'

/** Factory that creates a curate log store scoped to a project directory. */
export type CurateLogStoreFactory = (projectPath: string) => ICurateLogStore

/** Factory that creates a billing config store scoped to a project directory. */
export type BillingConfigStoreFactory = (projectPath: string) => IBillingConfigStore

export interface StatusHandlerDeps {
  authStateStore: IAuthStateStore
  billingConfigStoreFactory: BillingConfigStoreFactory
  billingService: IBillingService
  contextTreeService: IContextTreeService
  contextTreeSnapshotService: IContextTreeSnapshotService
  curateLogStoreFactory: CurateLogStoreFactory
  projectConfigStore: IProjectConfigStore
  providerConfigStore: IProviderConfigStore
  resolveProjectPath: ProjectPathResolver
  tokenStore: ITokenStore
  transport: ITransportServer
  webuiPort?: number
}

/**
 * Handles status:get event.
 * Collects auth, project, and context tree status — pure data, no terminal output.
 */
export class StatusHandler {
  private readonly authStateStore: IAuthStateStore
  private readonly billingConfigStoreFactory: BillingConfigStoreFactory
  private readonly billingService: IBillingService
  private readonly contextTreeService: IContextTreeService
  private readonly contextTreeSnapshotService: IContextTreeSnapshotService
  private readonly curateLogStoreFactory: CurateLogStoreFactory
  private readonly projectConfigStore: IProjectConfigStore
  private readonly providerConfigStore: IProviderConfigStore
  private readonly resolveProjectPath: ProjectPathResolver
  private readonly tokenStore: ITokenStore
  private readonly transport: ITransportServer
  private readonly webuiPort?: number

  constructor(deps: StatusHandlerDeps) {
    this.authStateStore = deps.authStateStore
    this.billingConfigStoreFactory = deps.billingConfigStoreFactory
    this.billingService = deps.billingService
    this.contextTreeService = deps.contextTreeService
    this.contextTreeSnapshotService = deps.contextTreeSnapshotService
    this.curateLogStoreFactory = deps.curateLogStoreFactory
    this.projectConfigStore = deps.projectConfigStore
    this.providerConfigStore = deps.providerConfigStore
    this.resolveProjectPath = deps.resolveProjectPath
    this.tokenStore = deps.tokenStore
    this.transport = deps.transport
    this.webuiPort = deps.webuiPort
  }

  setup(): void {
    this.transport.onRequest<StatusGetRequest | void, StatusGetResponse>(StatusEvents.GET, async (data, clientId) => {
      const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
      const request = data as StatusGetRequest | undefined
      const cwd = request?.cwd
      const projectRootFlag = request?.projectRootFlag
      const status = await this.collectStatus(projectPath, cwd, projectRootFlag)
      return {status}
    })
  }

  private async collectStatus(projectPath: string, clientCwd?: string, projectRootFlag?: string): Promise<StatusDTO> {
    const result: StatusDTO = {
      authStatus: 'unknown',
      contextTreeStatus: 'unknown',
      currentDirectory: projectPath,
      projectRoot: projectPath,
    }

    // Resolve workspace awareness from client cwd (if provided)
    // Use resolved projectRoot for all downstream checks to avoid inconsistency
    let effectiveProjectPath = projectPath
    if (clientCwd || projectRootFlag) {
      try {
        const resolution = resolveProject({cwd: clientCwd, projectRootFlag})
        if (resolution) {
          result.projectRoot = resolution.projectRoot
          result.worktreeRoot = resolution.worktreeRoot
          result.resolutionSource = resolution.source
          effectiveProjectPath = resolution.projectRoot
        }
      } catch (error) {
        // Surface broken/malformed link errors as actionable status info
        if (error instanceof BrokenWorktreePointerError || error instanceof MalformedWorktreePointerError) {
          result.resolverError = error.message
        }

        // Fall through with projectPath defaults for config/context checks
      }
    }

    // Preserve actual client working directory for backward compat
    result.currentDirectory = clientCwd ?? projectPath

    // Auth status
    try {
      const token = await this.tokenStore.load()
      if (token !== undefined && token.isValid()) {
        result.authStatus = 'logged_in'
        result.userEmail = token.userEmail
      } else if (token === undefined) {
        result.authStatus = 'not_logged_in'
      } else {
        result.authStatus = 'expired'
      }
    } catch {
      result.authStatus = 'unknown'
    }

    // Project status — use effectiveProjectPath for consistency with resolved root
    let projectConfig: Awaited<ReturnType<IProjectConfigStore['read']>> | undefined
    try {
      const isInitialized = await this.projectConfigStore.exists(effectiveProjectPath)
      if (isInitialized) {
        projectConfig = await this.projectConfigStore.read(effectiveProjectPath)
        if (projectConfig) {
          result.teamName = projectConfig.teamName
          result.spaceName = projectConfig.spaceName
        }
      }
    } catch {}

    result.billing = await resolveBillingForProject({
      authStateStore: this.authStateStore,
      billingConfigStoreFactory: this.billingConfigStoreFactory,
      billingService: this.billingService,
      projectPath: effectiveProjectPath,
      providerConfigStore: this.providerConfigStore,
    })

    // Abstract generation queue status (written by agent process via abstract-queue.ts)
    try {
      const queueStatusPath = join(projectPath, BRV_DIR, '_queue_status.json')
      const raw = await readFile(queueStatusPath, 'utf8')
      result.abstractQueue = JSON.parse(raw) as StatusDTO['abstractQueue']
    } catch {
      // File doesn't exist yet — no queue running
    }

    // Context tree status — use effectiveProjectPath for consistency with resolved root
    try {
      const contextTreeExists = await this.contextTreeService.exists(effectiveProjectPath)
      if (contextTreeExists) {
        const hasGitVc = await this.contextTreeService.hasGitRepo(effectiveProjectPath)
        if (hasGitVc) {
          result.contextTreeStatus = 'git_vc'
        } else {
          result.contextTreeDir = join(effectiveProjectPath, BRV_DIR, CONTEXT_TREE_DIR)
          result.contextTreeRelativeDir = join(BRV_DIR, CONTEXT_TREE_DIR)

          const hasLegacySyncConfig = Boolean(projectConfig?.teamId && projectConfig?.spaceId)

          if (hasLegacySyncConfig) {
            const hasSnapshot = await this.contextTreeSnapshotService.hasSnapshot(effectiveProjectPath)
            if (!hasSnapshot) {
              await this.contextTreeSnapshotService.initEmptySnapshot(effectiveProjectPath)
            }

            const changes = await this.contextTreeSnapshotService.getChanges(effectiveProjectPath)
            const hasChanges = changes.added.length > 0 || changes.modified.length > 0 || changes.deleted.length > 0

            if (hasChanges) {
              result.contextTreeStatus = 'has_changes'
              result.contextTreeChanges = {
                added: changes.added,
                deleted: changes.deleted,
                modified: changes.modified,
              }
            } else {
              result.contextTreeStatus = 'no_changes'
            }
          } else {
            result.contextTreeStatus = 'no_vc'
          }
        }
      } else {
        result.contextTreeStatus = 'not_initialized'
      }
    } catch {
      result.contextTreeStatus = 'unknown'
    }

    // Pending review count (best-effort)
    try {
      const store = this.curateLogStoreFactory(projectPath)
      const entries = await store.list({limit: 100, status: ['completed']})
      const pendingFiles = new Set<string>()
      const contextTreeRoot = join(projectPath, BRV_DIR, CONTEXT_TREE_DIR)

      for (const entry of entries) {
        for (const op of entry.operations) {
          if (op.reviewStatus === 'pending' && op.filePath) {
            const prefix = contextTreeRoot + '/'
            const relativePath = op.filePath.startsWith(prefix) ? op.filePath.slice(prefix.length) : op.filePath
            pendingFiles.add(relativePath)
          }
        }
      }

      if (pendingFiles.size > 0) {
        result.pendingReviewCount = pendingFiles.size
        if (this.webuiPort) {
          result.reviewUrl = buildReviewUrl(this.webuiPort, projectPath)
        }
      }
    } catch {
      // Best-effort — if the log is unavailable, skip review info
    }

    // Knowledge sources status
    try {
      const sourcesResult = listSourceStatuses(effectiveProjectPath)
      if (sourcesResult.error) {
        result.sourcesError = sourcesResult.error
      } else if (sourcesResult.statuses.length > 0) {
        result.sources = sourcesResult.statuses
      }
    } catch {
      // Best-effort — swallow errors
    }

    return result
  }
}

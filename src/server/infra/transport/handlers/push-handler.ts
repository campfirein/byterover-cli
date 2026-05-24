import {join, relative} from 'node:path'

import type {ITokenStore} from '../../../core/interfaces/auth/i-token-store.js'
import type {IContextFileReader} from '../../../core/interfaces/context-tree/i-context-file-reader.js'
import type {IContextTreeService} from '../../../core/interfaces/context-tree/i-context-tree-service.js'
import type {IContextTreeSnapshotService} from '../../../core/interfaces/context-tree/i-context-tree-snapshot-service.js'
import type {ICogitPushService} from '../../../core/interfaces/services/i-cogit-push-service.js'
import type {ICurateLogStore} from '../../../core/interfaces/storage/i-curate-log-store.js'
import type {IProjectConfigStore} from '../../../core/interfaces/storage/i-project-config-store.js'
import type {IReviewBackupStore} from '../../../core/interfaces/storage/i-review-backup-store.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {
  PushEvents,
  type PushExecuteRequest,
  type PushExecuteResponse,
  type PushPrepareRequest,
  type PushPrepareResponse,
} from '../../../../shared/transport/events/push-events.js'
import {
  LegacySyncUnavailableError,
  NotAuthenticatedError,
  ProjectNotInitError,
} from '../../../core/domain/errors/task-error.js'
import {buildReviewUrl} from '../../../utils/build-review-url.js'
import {mapToPushContexts} from '../../cogit/context-tree-to-push-context-mapper.js'
import {
  guardAgainstGitVc,
  type ProjectBroadcaster,
  type ProjectPathResolver,
  resolveRequiredProjectPath,
} from './handler-types.js'

/** Factory that creates a curate log store scoped to a project directory. */
export type CurateLogStoreFactory = (projectPath: string) => ICurateLogStore

/** Path prefix of the context tree relative to the project root. */
const CONTEXT_TREE_RELATIVE = join('.brv', 'context-tree')

export interface PushHandlerDeps {
  broadcastToProject: ProjectBroadcaster
  cogitPushService: ICogitPushService
  contextFileReader: IContextFileReader
  contextTreeService: IContextTreeService
  contextTreeSnapshotService: IContextTreeSnapshotService
  curateLogStoreFactory: CurateLogStoreFactory
  projectConfigStore: IProjectConfigStore
  resolveProjectPath: ProjectPathResolver
  reviewBackupStoreFactory: (projectPath: string) => IReviewBackupStore
  tokenStore: ITokenStore
  transport: ITransportServer
  webAppUrl: string
  webuiPort?: number
}

/**
 * Handles push:* events.
 * Business logic for pushing context tree to cloud — no terminal/UI calls.
 */
export class PushHandler {
  private readonly broadcastToProject: ProjectBroadcaster
  private readonly cogitPushService: ICogitPushService
  private readonly contextFileReader: IContextFileReader
  private readonly contextTreeService: IContextTreeService
  private readonly contextTreeSnapshotService: IContextTreeSnapshotService
  private readonly curateLogStoreFactory: CurateLogStoreFactory
  private readonly projectConfigStore: IProjectConfigStore
  private readonly resolveProjectPath: ProjectPathResolver
  private readonly reviewBackupStoreFactory: (projectPath: string) => IReviewBackupStore
  private readonly tokenStore: ITokenStore
  private readonly transport: ITransportServer
  private readonly webAppUrl: string
  private readonly webuiPort?: number

  constructor(deps: PushHandlerDeps) {
    this.broadcastToProject = deps.broadcastToProject
    this.cogitPushService = deps.cogitPushService
    this.contextFileReader = deps.contextFileReader
    this.contextTreeService = deps.contextTreeService
    this.contextTreeSnapshotService = deps.contextTreeSnapshotService
    this.curateLogStoreFactory = deps.curateLogStoreFactory
    this.projectConfigStore = deps.projectConfigStore
    this.resolveProjectPath = deps.resolveProjectPath
    this.reviewBackupStoreFactory = deps.reviewBackupStoreFactory
    this.tokenStore = deps.tokenStore
    this.transport = deps.transport
    this.webAppUrl = deps.webAppUrl
    this.webuiPort = deps.webuiPort
  }

  setup(): void {
    this.transport.onRequest<PushPrepareRequest, PushPrepareResponse>(PushEvents.PREPARE, (data, clientId) =>
      this.handlePrepare(data, clientId),
    )

    this.transport.onRequest<PushExecuteRequest, PushExecuteResponse>(PushEvents.EXECUTE, (data, clientId) =>
      this.handleExecute(data, clientId),
    )
  }

  /**
   * Filter a list of file paths, removing any with pending or rejected review status.
   */
  private filterPushablePaths(
    paths: string[],
    reviewStatuses: Map<string, 'approved' | 'pending' | 'rejected'>,
  ): string[] {
    return paths.filter((path) => {
      const status = reviewStatuses.get(path)
      return status !== 'pending' && status !== 'rejected'
    })
  }

  /**
   * Build a map of context-tree-relative file path → review status from the curate log.
   * Uses newest-wins strategy for the same file across multiple entries.
   */
  private async getFileReviewStatuses(
    projectPath: string,
  ): Promise<Map<string, 'approved' | 'pending' | 'rejected'>> {
    const map = new Map<string, 'approved' | 'pending' | 'rejected'>()

    try {
      const store = this.curateLogStoreFactory(projectPath)
      const entries = await store.list({limit: 500, status: ['completed']})
      const contextTreeRoot = join(projectPath, CONTEXT_TREE_RELATIVE)

      // Process oldest-first so the newest entry wins for each path
      for (const entry of [...entries].reverse()) {
        for (const op of entry.operations) {
          if (!op.filePath || !op.reviewStatus) continue

          const relativePath = relative(contextTreeRoot, op.filePath)
          if (relativePath.startsWith('..')) continue

          map.set(relativePath, op.reviewStatus)
        }
      }
    } catch {
      // Best-effort
    }

    return map
  }

  private async handleExecute(data: PushExecuteRequest, clientId: string): Promise<PushExecuteResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    await guardAgainstGitVc({contextTreeService: this.contextTreeService, projectPath})

    const token = await this.tokenStore.load()
    if (!token || !token.isValid()) {
      throw new NotAuthenticatedError()
    }

    const config = await this.projectConfigStore.read(projectPath)
    if (!config) {
      throw new ProjectNotInitError()
    }

    if (!config.teamId || !config.spaceId) {
      throw new LegacySyncUnavailableError()
    }

    this.broadcastToProject(projectPath, PushEvents.PROGRESS, {message: 'Reading context files...', step: 'reading'})

    const changes = await this.contextTreeSnapshotService.getChanges(projectPath)

    // Filter out files with pending/rejected review status
    const reviewStatuses = await this.getFileReviewStatuses(projectPath)
    const pushableAdded = this.filterPushablePaths(changes.added, reviewStatuses)
    const pushableModified = this.filterPushablePaths(changes.modified, reviewStatuses)
    const pushableDeleted = this.filterPushablePaths(changes.deleted, reviewStatuses)

    const [addedFiles, modifiedFiles] = await Promise.all([
      this.contextFileReader.readMany(pushableAdded, projectPath),
      this.contextFileReader.readMany(pushableModified, projectPath),
    ])

    const pushContexts = mapToPushContexts({
      addedFiles,
      deletedPaths: pushableDeleted,
      modifiedFiles,
    })

    this.broadcastToProject(projectPath, PushEvents.PROGRESS, {message: 'Pushing to cloud...', step: 'pushing'})

    await this.cogitPushService.push({
      accessToken: token.accessToken,
      branch: data.branch,
      contexts: pushContexts,
      sessionKey: token.sessionKey,
      spaceId: config.spaceId,
      teamId: config.teamId,
    })

    // Save snapshot selectively: only record pushed files so excluded files
    // still appear as changes in the next push.
    const oldSnapshot = await this.contextTreeSnapshotService.getSnapshotState(projectPath)
    const currentState = await this.contextTreeSnapshotService.getCurrentState(projectPath)
    const newSnapshot = new Map(oldSnapshot)

    for (const path of pushableAdded) {
      const state = currentState.get(path)
      if (state) newSnapshot.set(path, state)
    }

    for (const path of pushableModified) {
      const state = currentState.get(path)
      if (state) newSnapshot.set(path, state)
    }

    for (const path of pushableDeleted) {
      newSnapshot.delete(path)
    }

    await this.contextTreeSnapshotService.saveSnapshotFromState(newSnapshot, projectPath)

    // Best-effort: clear backups for pushed files so the pushed state becomes the new diff baseline
    try {
      const backupStore = this.reviewBackupStoreFactory(projectPath)
      await Promise.all(
        [...pushableAdded, ...pushableModified, ...pushableDeleted].map((p) => backupStore.delete(p)),
      )
    } catch {
      // Backup cleanup must never block the push response
    }

    const url = `${this.webAppUrl}/${config.teamName}/${config.spaceName}`

    return {
      added: addedFiles.length,
      deleted: pushableDeleted.length,
      edited: modifiedFiles.length,
      success: true,
      url,
    }
  }

  private async handlePrepare(_data: PushPrepareRequest, clientId: string): Promise<PushPrepareResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    await guardAgainstGitVc({contextTreeService: this.contextTreeService, projectPath})

    const token = await this.tokenStore.load()
    if (!token || !token.isValid()) {
      throw new NotAuthenticatedError()
    }

    const config = await this.projectConfigStore.read(projectPath)
    if (!config) {
      throw new ProjectNotInitError()
    }

    if (!config.teamId || !config.spaceId) {
      throw new LegacySyncUnavailableError()
    }

    const hasSnapshot = await this.contextTreeSnapshotService.hasSnapshot(projectPath)
    if (!hasSnapshot) {
      await this.contextTreeSnapshotService.initEmptySnapshot(projectPath)
    }

    const changes = await this.contextTreeSnapshotService.getChanges(projectPath)

    // Get review statuses and filter pushable files
    const reviewStatuses = await this.getFileReviewStatuses(projectPath)
    const pushableAdded = this.filterPushablePaths(changes.added, reviewStatuses)
    const pushableModified = this.filterPushablePaths(changes.modified, reviewStatuses)
    const pushableDeleted = this.filterPushablePaths(changes.deleted, reviewStatuses)

    const totalChanges = changes.added.length + changes.modified.length + changes.deleted.length
    const pushableTotal = pushableAdded.length + pushableModified.length + pushableDeleted.length
    const excludedReviewCount = totalChanges - pushableTotal

    // Count pending reviews from review statuses map
    let pendingReviewCount = 0
    for (const status of reviewStatuses.values()) {
      if (status === 'pending') pendingReviewCount++
    }

    const parts: string[] = []
    if (pushableAdded.length > 0) parts.push(`${pushableAdded.length} added`)
    if (pushableModified.length > 0) parts.push(`${pushableModified.length} modified`)
    if (pushableDeleted.length > 0) parts.push(`${pushableDeleted.length} deleted`)

    let reviewUrl: string | undefined
    if (pendingReviewCount > 0 && this.webuiPort) {
      reviewUrl = buildReviewUrl(this.webuiPort, projectPath)
    }

    return {
      excludedReviewCount,
      fileCount: pushableTotal,
      hasChanges: pushableTotal > 0,
      pendingReviewCount,
      ...(reviewUrl ? {reviewUrl} : {}),
      summary: parts.length > 0 ? parts.join(', ') : 'No changes',
    }
  }
}

import {copyFile, mkdir, opendir, readFile, rename, rm, stat, unlink, writeFile} from 'node:fs/promises'
import {dirname, extname, join} from 'node:path'

import type {FileState} from '../../core/domain/entities/context-tree-snapshot.js'
import type {
  IContextTreeMerger,
  MergeParams,
  MergeResult,
} from '../../core/interfaces/context-tree/i-context-tree-merger.js'
import type {IContextTreeSnapshotService} from '../../core/interfaces/context-tree/i-context-tree-snapshot-service.js'

import {BRV_DIR, CONTEXT_TREE_BACKUP_DIR, CONTEXT_TREE_CONFLICT_DIR, CONTEXT_TREE_DIR, INDEX_HTML_FILE} from '../../constants.js'
import {isExcludedFromSync} from './derived-artifact.js'
import {computeContentHash} from './hash-utils.js'
import {toUnixPath} from './path-utils.js'

export type FileContextTreeMergerDependencies = {
  snapshotService: IContextTreeSnapshotService
}

/**
 * File-based implementation of IContextTreeMerger.
 *
 * Merge decision per file (remote hash compared against last snapshot hash):
 *   - Remote unchanged  → skip; local version wins regardless of local state.
 *   - Remote changed, local clean, preserveLocalFiles=false → overwrite with remote (regular pull).
 *   - Remote changed, local clean, preserveLocalFiles=true  → conflict (first-time connect; no
 *     shared history so the local file is not treated as "old").
 *   - Remote changed, local also changed                    → conflict.
 *   Conflict handling: local copy saved to .brv/context-tree-conflicts/ and renamed _N.md;
 *   remote content written to the original path.
 *
 * Clean local files absent from remote are deleted (preserveLocalFiles=false) or preserved
 * (preserveLocalFiles=true). Locally-deleted files are re-created if remote has a newer version.
 *
 * A full backup of the context tree is taken before each merge and used for automatic rollback
 * on failure. The backup is deleted after a successful merge.
 */
export class FileContextTreeMerger implements IContextTreeMerger {
  private static readonly MAX_RENAME_ATTEMPTS = 100
  private readonly snapshotService: IContextTreeSnapshotService

  public constructor(deps: FileContextTreeMergerDependencies) {
    this.snapshotService = deps.snapshotService
  }

  private static isErrnoException(e: unknown): e is NodeJS.ErrnoException {
    return e instanceof Error && 'code' in e
  }

  public async merge(params: MergeParams): Promise<MergeResult> {
    const {directory, files, localChanges, preserveLocalFiles = false} = params
    const contextTreeDir = join(directory, BRV_DIR, CONTEXT_TREE_DIR)
    const backupDir = join(directory, BRV_DIR, CONTEXT_TREE_BACKUP_DIR)
    const conflictDir = join(directory, BRV_DIR, CONTEXT_TREE_CONFLICT_DIR)

    // Capture pre-merge disk state and saved snapshot state for comparison
    const localState = await this.snapshotService.getCurrentState(directory)
    const snapshotState = await this.snapshotService.getSnapshotState(directory)

    // Only added/modified files can conflict — deleted files are absent from disk so they
    // cannot be read during conflict handling. Locally-deleted + remote-changed falls through
    // to the "file not on disk" branch in runMerge(), where remote wins by re-creating the file.
    const locallyChangedPaths = new Set([...localChanges.added, ...localChanges.modified])

    const remoteFilesMap = this.buildRemoteFilesMap(files)

    // Clear any leftover backup or conflict folder from a previous merge.
    await rm(backupDir, {force: true, recursive: true})
    await rm(conflictDir, {force: true, recursive: true})

    // Backup local context tree as a safety net for rollback on failure.
    try {
      await this.copyDir(contextTreeDir, backupDir)
    } catch (error) {
      if (!FileContextTreeMerger.isErrnoException(error) || error.code !== 'ENOENT') throw error
      // Context tree dir does not exist — nothing to back up, continue
    }

    try {
      const result = await this.runMerge({
        conflictDir,
        contextTreeDir,
        locallyChangedPaths,
        localState,
        preserveLocalFiles,
        remoteFilesMap,
        snapshotState,
      })

      // Save snapshot atomically before deleting backup.
      // If this fails, the catch block will restore the context tree from the backup.
      await this.snapshotService.saveSnapshotFromState(result.remoteFileStates, directory)

      // Snapshot saved — backup is no longer needed.
      await rm(backupDir, {force: true, recursive: true})

      const mergeResult: MergeResult = {
        added: result.added,
        conflicted: result.conflicted,
        deleted: result.deleted,
        edited: result.edited,
        restoredFromRemote: result.restoredFromRemote,
      }

      return mergeResult
    } catch (error) {
      // Failure: automatically restore context tree from backup.
      await rm(contextTreeDir, {force: true, recursive: true})
      try {
        await rename(backupDir, contextTreeDir)
      } catch {
        // Backup does not exist (context tree was empty before merge) — context tree is cleanly absent.
      }

      // Remove any partial conflict directory created before the failure.
      await rm(conflictDir, {force: true, recursive: true}).catch(() => {})

      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Merge failed: ${message}. Context tree has been restored to its original state.`)
    }
  }

  /**
   * Builds a map of remote files with normalized paths and decoded content.
   */
  private buildRemoteFilesMap(files: MergeParams['files']): Map<string, {decodedContent: string}> {
    const result = new Map<string, {decodedContent: string}>()

    for (const file of files) {
      const normalPath = toUnixPath(file.path).replace(/^\/+/, '')
      result.set(normalPath, {decodedContent: file.decodeContent()})
    }

    return result
  }

  /**
   * Recursively copies a directory tree from src to dest.
   */
  private async copyDir(src: string, dest: string): Promise<void> {
    await mkdir(dest, {recursive: true})
    const dir = await opendir(src)
    for await (const entry of dir) {
      const srcPath = join(src, entry.name)
      const destPath = join(dest, entry.name)
      await (entry.isDirectory() ? this.copyDir(srcPath, destPath) : copyFile(srcPath, destPath))
    }
  }

  /**
   * Finds the first available filename by inserting _N before the extension.
   * e.g. "path/to/file.md" → "path/to/file_1.md", "path/to/file_2.md", …
   */
  private async findAvailableName(contextTreeDir: string, relativePath: string): Promise<string> {
    const ext = extname(relativePath) // '.md'
    const withoutExt = relativePath.slice(0, -ext.length) // 'path/to/file'

    for (let n = 1; n <= FileContextTreeMerger.MAX_RENAME_ATTEMPTS; n++) {
      const candidate = `${withoutExt}_${n}${ext}`
      const fullPath = join(contextTreeDir, candidate)

      try {
        // eslint-disable-next-line no-await-in-loop
        await stat(fullPath)
        // File exists — try next number
      } catch {
        return candidate
      }
    }

    throw new Error(
      `Cannot find available name for ${relativePath} after ${FileContextTreeMerger.MAX_RENAME_ATTEMPTS} attempts`,
    )
  }

  private async runMerge(params: {
    conflictDir: string
    contextTreeDir: string
    locallyChangedPaths: Set<string>
    localState: Map<string, FileState>
    preserveLocalFiles: boolean
    remoteFilesMap: Map<string, {decodedContent: string}>
    snapshotState: Map<string, FileState>
  }): Promise<MergeResult & {remoteFileStates: Map<string, FileState>}> {
    const {
      conflictDir,
      contextTreeDir,
      locallyChangedPaths,
      localState,
      preserveLocalFiles,
      remoteFilesMap,
      snapshotState,
    } = params

    const added: string[] = []
    const edited: string[] = []
    const deleted: string[] = []
    const conflicted: string[] = []
    const restoredFromRemote: string[] = []
    const remoteFileStates: Map<string, FileState> = new Map()

    /* eslint-disable no-await-in-loop */
    for (const [normalPath, file] of remoteFilesMap) {
      // Skip derived artifacts (_index.md, _archived/*, _manifest.json)
      if (isExcludedFromSync(normalPath)) continue

      // Root index.html is sync-tracked but auto-resolved on merge: any
      // divergence between local and remote is spurious because the file is
      // derived from the topic set. The caller regenerates it after the merge
      // settles. Root-only match — a user-authored `architecture/index.html`
      // is a regular topic and must follow the normal merge path.
      if (toUnixPath(normalPath) === INDEX_HTML_FILE) continue

      const targetPath = join(contextTreeDir, normalPath)
      const remoteHash = computeContentHash(file.decodedContent)
      const snapshotHash = snapshotState.get(normalPath)?.hash

      remoteFileStates.set(normalPath, {
        hash: remoteHash,
        size: Buffer.byteLength(file.decodedContent, 'utf8'),
      })

      if (remoteHash === snapshotHash) {
        // Remote has NOT changed this file — local wins, skip regardless of local state
        continue
      }

      // Remote has changed this file (or it is new to remote).
      if (locallyChangedPaths.has(normalPath)) {
        // Both sides changed — check if content is actually different before treating as conflict.
        const localContent = await readFile(targetPath, 'utf8')

        if (localContent === file.decodedContent) {
          // Both sides converged on the same content — no real conflict, treat as edited.
          edited.push(normalPath)
        } else {
          // True conflict: preserve original local in conflict dir, rename local to _N.md,
          // write remote to original path.
          const newRelPath = await this.writeConflict({
            conflictDir,
            contextTreeDir,
            localContent,
            normalPath,
            remoteContent: file.decodedContent,
            targetPath,
          })
          added.push(newRelPath)
          conflicted.push(normalPath)
        }
      } else if (localState.has(normalPath)) {
        if (preserveLocalFiles) {
          // First-time connect: no shared history — treat tracked+clean file as a conflict.
          // Convergence cannot occur here: local is clean (equals snapshot) and remote hash ≠
          // snapshot hash, so the contents are guaranteed to differ.
          const localContent = await readFile(targetPath, 'utf8')
          const newRelPath = await this.writeConflict({
            conflictDir,
            contextTreeDir,
            localContent,
            normalPath,
            remoteContent: file.decodedContent,
            targetPath,
          })
          added.push(newRelPath)
          conflicted.push(normalPath)
        } else {
          // Regular pull: file exists locally and is clean — overwrite with remote
          await writeFile(targetPath, file.decodedContent, 'utf8')
          edited.push(normalPath)
        }
      } else {
        // File not on disk — either new from remote or locally deleted with remote having newer version.
        await mkdir(dirname(targetPath), {recursive: true})
        await writeFile(targetPath, file.decodedContent, 'utf8')

        if (snapshotState.has(normalPath)) {
          // File was in the last snapshot but is absent from disk — user deleted it.
          // Remote has a newer version so it is restored. Track this so the caller can notify the user.
          restoredFromRemote.push(normalPath)
        }

        added.push(normalPath)
      }
    }

    // Apply remote deletions: if a file no longer exists in remote, remote deleted it — sync
    // that deletion locally. Skip files with local changes so the user's work is not lost.
    //
    // Skip entirely when preserveLocalFiles=true (first-time space connect): the local context
    // tree has no shared history with the target space, so "absent from remote" means
    // "remote has never seen it", not "remote deleted it".
    if (!preserveLocalFiles) {
      for (const localPath of localState.keys()) {
        const isLocallyChanged = locallyChangedPaths.has(localPath)
        const isInRemote = remoteFilesMap.has(localPath)

        if (!isLocallyChanged && !isInRemote) {
          await unlink(join(contextTreeDir, localPath))
          deleted.push(localPath)
        }
      }
    }
    /* eslint-enable no-await-in-loop */

    return {added, conflicted, deleted, edited, remoteFileStates, restoredFromRemote}
  }

  /**
   * Handles a true conflict: saves the local content to the conflict dir and as a _N.md
   * rename, then writes remote content to the original path.
   *
   * @returns The _N.md relative path that the local content was saved to.
   */
  private async writeConflict(params: {
    conflictDir: string
    contextTreeDir: string
    localContent: string
    normalPath: string
    remoteContent: string
    targetPath: string
  }): Promise<string> {
    const {conflictDir, contextTreeDir, localContent, normalPath, remoteContent, targetPath} = params

    // Copy original to conflict dir for review
    const conflictTargetPath = join(conflictDir, normalPath)
    await mkdir(dirname(conflictTargetPath), {recursive: true})
    await writeFile(conflictTargetPath, localContent, 'utf8')

    // Save local version at _N.md
    const newRelPath = await this.findAvailableName(contextTreeDir, normalPath)
    const newTargetPath = join(contextTreeDir, newRelPath)
    await mkdir(dirname(newTargetPath), {recursive: true})
    await writeFile(newTargetPath, localContent, 'utf8')

    // Write remote to original path
    await mkdir(dirname(targetPath), {recursive: true})
    await writeFile(targetPath, remoteContent, 'utf8')

    return newRelPath
  }
}

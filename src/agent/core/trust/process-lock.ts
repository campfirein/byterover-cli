import {existsSync, readFileSync} from 'node:fs'
import {open, unlink} from 'node:fs/promises'

/**
 * Minimal cross-process exclusion using `open(path, 'wx')` — atomic on
 * POSIX (O_CREAT | O_EXCL) and on Windows via the Node fs layer. Holds
 * a sibling `.lock` file containing the holder's PID for the duration
 * of the critical section. Unlinks on success OR on error.
 *
 * v1 limitations (documented per opencode round-2 MEDIUM):
 *   - Stale-lock risk: if a holder crashes mid-section without removing
 *     the lockfile, the next caller hits ELOCKED. We mitigate by
 *     checking whether the PID in the stale lock corresponds to a
 *     live process (kill 0 signal); if not, we steal the lock with a
 *     warning. The PID check is best-effort — a different process may
 *     have recycled the PID. v1 accepts this rare false-stale risk.
 *   - NOT a file-content lock: the lockfile is a sentinel, not a
 *     content lock. Concurrent reads (which don't acquire) are NOT
 *     serialised — readers may observe a half-rewritten state during
 *     a write window. The InstallIdentityService loadFromDisk path
 *     does an integrity check (cert.subject_id matches decrypted
 *     peer_id) that catches the most dangerous mismatch.
 */
export async function withProcessLock<T>(lockPath: string, body: () => Promise<T>): Promise<T> {
  await acquireLock(lockPath)
  try {
    return await body()
  } finally {
    await releaseLock(lockPath)
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  try {
    const handle = await open(lockPath, 'wx', 0o600)
    await handle.write(`${process.pid}\n`)
    await handle.close()
  } catch (error) {
    if (!isEEXIST(error)) throw error
    // Stale-lock check: is the PID in the lockfile a live process?
    if (existsSync(lockPath) && !isHeldByLiveProcess(lockPath)) {
      // Steal the lock.
      await unlink(lockPath).catch(() => {})
      // Recurse once to acquire (single retry; if it fails again, propagate).
      const handle = await open(lockPath, 'wx', 0o600)
      await handle.write(`${process.pid}\n`)
      await handle.close()
      return
    }

    throw new Error(`identity dir is locked by another process (lockfile: ${lockPath})`)
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  await unlink(lockPath).catch(() => {})
}

function isEEXIST(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST'
}

function isHeldByLiveProcess(lockPath: string): boolean {
  try {
    const pidStr = readFileSync(lockPath, 'utf8').trim()
    const pid = Number.parseInt(pidStr, 10)
    if (!Number.isFinite(pid) || pid <= 0) return false
    // kill(pid, 0) probes process existence without sending a signal.
    // ESRCH = no such process; EPERM = process exists but we can't signal.
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      const {code} = (error as NodeJS.ErrnoException)
      if (code === 'EPERM') return true
      return false  // ESRCH or anything else → stale
    }
  } catch {
    return false
  }
}

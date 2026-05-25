import {promises as fs} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

/**
 * Creates a fresh empty temp directory under the OS temp area and returns its
 * absolute path. Caller is responsible for cleanup via {@link removeTempDir}.
 *
 * Used by Phase 1 integration tests for orphan paths (e.g. a BRV_DATA_DIR with
 * no `state/daemon-auth-token`, to exercise the auth-rejection canary).
 */
export const makeTempDir = async (prefix = 'brv-test-'): Promise<string> =>
  fs.mkdtemp(join(tmpdir(), prefix))

/**
 * Recursively removes a temp directory. Safe to call on a missing path.
 */
export const removeTempDir = async (path: string): Promise<void> => {
  await fs.rm(path, {force: true, recursive: true})
}

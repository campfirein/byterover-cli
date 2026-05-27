import {createHash} from 'node:crypto'

/**
 * SHA-256 hex digest of a path string, used by analytics emits that want
 * to identify a project / file / source without leaking the raw absolute
 * path. Raw paths are on `FORBIDDEN_FIELD_NAMES` (and are PII-adjacent at
 * volume); the hash gives downstream consumers a stable join key without
 * revealing the source.
 *
 * Verbatim hash, no normalization — trailing slashes, case, and symlink
 * resolution are caller-side concerns. Callers SHOULD pass the canonical
 * absolute path their handler resolved (e.g. via `resolveProjectPath`)
 * so the hash is stable across emits for the same project.
 */
export function hashProjectPath(path: string): string {
  return createHash('sha256').update(path).digest('hex')
}

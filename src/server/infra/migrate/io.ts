/**
 * Atomic-write + cross-device move helpers.
 *
 * Ports lines 1609-1623 of the Python oracle. Both helpers force LF
 * line endings on disk so multi-operator output stays byte-equal
 * across macOS/Linux/Windows.
 */

import {
  copyFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import {dirname} from 'node:path'

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

/**
 * Move `source` to `target` (creating parent dirs on the way). Uses
 * `rename` first, falls back to copy+unlink on EXDEV (cross-device).
 */
export function moveFile(source: string, target: string): void {
  mkdirSync(dirname(target), {recursive: true})
  try {
    renameSync(source, target)
  } catch (error: unknown) {
    if (!isErrnoException(error) || error.code !== 'EXDEV') throw error
    copyFileSync(source, target)
    unlinkSync(source)
  }
}

/**
 * Write `content` to `target` atomically: write to `target + '.tmp'`,
 * then rename over. Forces LF endings on disk (no `os.EOL`).
 */
export function writeAtomic(target: string, content: string): void {
  mkdirSync(dirname(target), {recursive: true})
  const tmp = `${target}.tmp`
  writeFileSync(tmp, content, {encoding: 'utf8'})
  renameSync(tmp, target)
}

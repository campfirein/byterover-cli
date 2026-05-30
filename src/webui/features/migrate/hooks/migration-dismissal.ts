const KEY_PREFIX = 'brv:migrate-dismissed:'

// djb2 — small, deterministic, no crypto dependency. We just need a
// stable opaque key; collisions don't have security implications here
// because the value is a boolean flag scoped to one local user.
function hashProjectRoot(projectRoot: string): string {
  let hash = 5381
  for (const char of projectRoot) {
    const code = char.codePointAt(0) ?? 0
    // eslint-disable-next-line no-bitwise
    hash = Math.imul(hash, 33) ^ code
  }

  // eslint-disable-next-line no-bitwise
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function migrationDismissalKey(projectRoot: string): string {
  return `${KEY_PREFIX}${hashProjectRoot(projectRoot)}`
}

type StorageLike = globalThis.Storage

function safeStorage(storage?: StorageLike): StorageLike | undefined {
  if (storage) return storage
  if (typeof globalThis === 'undefined') return undefined
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export function isMigrationPromptDismissed(projectRoot: string, storage?: StorageLike): boolean {
  const store = safeStorage(storage)
  if (!store) return false
  try {
    return store.getItem(migrationDismissalKey(projectRoot)) === '1'
  } catch {
    return false
  }
}

export function dismissMigrationPrompt(projectRoot: string, storage?: StorageLike): void {
  const store = safeStorage(storage)
  if (!store) return
  try {
    store.setItem(migrationDismissalKey(projectRoot), '1')
  } catch {
    // ignore (private browsing, quota, etc.)
  }
}

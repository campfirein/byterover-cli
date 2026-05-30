import {expect} from 'chai'

import {
  dismissMigrationPrompt,
  isMigrationPromptDismissed,
  migrationDismissalKey,
} from '../../../../../../src/webui/features/migrate/hooks/migration-dismissal.js'

interface StorageLike {
  clear(): void
  getItem(key: string): null | string
  removeItem(key: string): void
  setItem(key: string, value: string): void
}

function createMemoryStorage(): StorageLike {
  const store = new Map<string, string>()
  return {
    clear() {
      store.clear()
    },
    getItem(key) {
      return store.has(key) ? (store.get(key) as string) : null
    },
    removeItem(key) {
      store.delete(key)
    },
    setItem(key, value) {
      store.set(key, value)
    },
  }
}

describe('migration dismissal storage', () => {
  let storage: StorageLike

  beforeEach(() => {
    storage = createMemoryStorage()
  })

  it('produces a hashed, project-scoped key (no raw path)', () => {
    const a = migrationDismissalKey('/tmp/a')
    const b = migrationDismissalKey('/tmp/b')
    expect(a).to.match(/^brv:migrate-dismissed:[\da-f]{8}$/)
    expect(b).to.match(/^brv:migrate-dismissed:[\da-f]{8}$/)
    expect(a).to.not.equal(b)
    expect(a).to.not.include('/tmp/a')
  })

  it('is deterministic for the same projectRoot', () => {
    expect(migrationDismissalKey('/tmp/a')).to.equal(migrationDismissalKey('/tmp/a'))
  })

  it('is not dismissed by default', () => {
    expect(isMigrationPromptDismissed('/tmp/a', storage as unknown as globalThis.Storage)).to.equal(false)
  })

  it('marks dismissed per project', () => {
    dismissMigrationPrompt('/tmp/a', storage as unknown as globalThis.Storage)
    expect(isMigrationPromptDismissed('/tmp/a', storage as unknown as globalThis.Storage)).to.equal(true)
    expect(isMigrationPromptDismissed('/tmp/b', storage as unknown as globalThis.Storage)).to.equal(false)
  })

  it('returns false when storage access throws (private browsing)', () => {
    const broken = {
      getItem() {
        throw new Error('blocked')
      },
      setItem() {
        throw new Error('blocked')
      },
    } as unknown as globalThis.Storage
    expect(isMigrationPromptDismissed('/tmp/a', broken)).to.equal(false)
    expect(() => {
      dismissMigrationPrompt('/tmp/a', broken)
    }).to.not.throw()
  })
})

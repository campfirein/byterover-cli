import {expect} from 'chai'
import {existsSync} from 'node:fs'
import {mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {SettingDescriptor} from '../../../../src/server/core/domain/entities/settings.js'

import {FileSettingsStore} from '../../../../src/server/infra/storage/file-settings-store.js'
import {
  InvalidSettingValueError,
  ReadonlySettingKeyError,
  SettingsValidator,
  UnknownSettingKeyError,
} from '../../../../src/server/infra/storage/settings-validator.js'

const SETTINGS_FILENAME = 'settings.json'

type SettingsFile = {values: Record<string, unknown>; version: string}

function asSettingsFile(value: unknown): SettingsFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('expected an object')
  }

  const obj = value as Record<string, unknown>
  if (typeof obj.version !== 'string') throw new TypeError('expected string version')
  const {values} = obj
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw new TypeError('expected object values')
  }

  return {values: values as Record<string, unknown>, version: obj.version}
}

describe('FileSettingsStore', () => {
  let tempDir: string
  let store: FileSettingsStore

  beforeEach(async () => {
    tempDir = join(tmpdir(), `brv-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tempDir, {recursive: true})
    store = new FileSettingsStore({baseDir: tempDir})
  })

  afterEach(async () => {
    await rm(tempDir, {force: true, recursive: true})
  })

  describe('list', () => {
    it('returns all registered keys with defaults when no file exists', async () => {
      const items = await store.list()
      const keys = items.map((i) => i.key).sort()
      expect(keys).to.deep.equal([
        'agentPool.maxConcurrentTasksPerProject',
        'agentPool.maxSize',
        'analytics.status',
        'llm.iterationBudgetMs',
        'llm.requestTimeoutMs',
        'taskHistory.maxEntries',
        'update.checkForUpdates',
      ])
      for (const item of items) {
        // readonly-info rows carry current/default both undefined; writable
        // rows have current === default when no override is present.
        if (item.key === 'analytics.status') {
          expect(item.current).to.equal(undefined)
          expect(item.default).to.equal(undefined)
        } else {
          expect(item.current).to.equal(item.default)
        }
      }
    })

    it('reflects overrides written to the file', async () => {
      await store.set('agentPool.maxSize', 25)
      const items = await store.list()
      const maxSize = items.find((i) => i.key === 'agentPool.maxSize')
      expect(maxSize).to.exist
      expect(maxSize?.current).to.equal(25)
      expect(maxSize?.default).to.not.equal(25)
    })
  })

  describe('get', () => {
    it('returns current=default for a key not in the file', async () => {
      const item = await store.get('agentPool.maxSize')
      expect(item.key).to.equal('agentPool.maxSize')
      expect(item.current).to.equal(item.default)
      expect(item.restartRequired).to.equal(true)
    })

    it('returns the overridden value when set', async () => {
      await store.set('taskHistory.maxEntries', 5000)
      const item = await store.get('taskHistory.maxEntries')
      expect(item.current).to.equal(5000)
    })

    it('throws UnknownSettingKeyError for an unknown key', async () => {
      try {
        await store.get('not.a.real.key')
        expect.fail('expected throw')
      } catch (error) {
        expect(error).to.be.instanceOf(UnknownSettingKeyError)
      }
    })
  })

  describe('set', () => {
    it('persists the value to settings.json', async () => {
      await store.set('agentPool.maxSize', 25)
      const content = await readFile(join(tempDir, SETTINGS_FILENAME), 'utf8')
      const parsed: unknown = JSON.parse(content)
      const file = asSettingsFile(parsed)
      expect(file.version).to.be.a('string')
      expect(file.values['agentPool.maxSize']).to.equal(25)
    })

    it('rejects unknown keys with UnknownSettingKeyError', async () => {
      try {
        await store.set('not.a.real.key', 1)
        expect.fail('expected throw')
      } catch (error) {
        expect(error).to.be.instanceOf(UnknownSettingKeyError)
      }
    })

    it('rejects values of the wrong type', async () => {
      try {
        await store.set('agentPool.maxSize', 'twenty')
        expect.fail('expected throw')
      } catch (error) {
        expect(error).to.be.instanceOf(InvalidSettingValueError)
      }
    })

    it('rejects out-of-range values', async () => {
      try {
        await store.set('agentPool.maxSize', 0)
        expect.fail('expected throw')
      } catch (error) {
        expect(error).to.be.instanceOf(InvalidSettingValueError)
      }
    })

    it('rejects llm.requestTimeoutMs when it would exceed llm.iterationBudgetMs', async () => {
      await store.set('llm.iterationBudgetMs', 300_000)
      try {
        await store.set('llm.requestTimeoutMs', 600_000)
        expect.fail('expected throw')
      } catch (error) {
        expect(error).to.be.instanceOf(InvalidSettingValueError)
        if (error instanceof InvalidSettingValueError) {
          expect(error.message).to.include('llm.requestTimeoutMs')
          expect(error.message).to.include('llm.iterationBudgetMs')
        }
      }
    })

    it('rejects llm.iterationBudgetMs when it would be smaller than llm.requestTimeoutMs', async () => {
      await store.set('llm.requestTimeoutMs', 600_000)
      try {
        await store.set('llm.iterationBudgetMs', 300_000)
        expect.fail('expected throw')
      } catch (error) {
        expect(error).to.be.instanceOf(InvalidSettingValueError)
      }
    })

    it('does not write the file when validation fails', async () => {
      try {
        await store.set('agentPool.maxSize', -1)
      } catch {
        /* expected */
      }

      const items = await store.list()
      const item = items.find((i) => i.key === 'agentPool.maxSize')
      expect(item?.current).to.equal(item?.default)
    })

    it('preserves other overrides when setting a new key', async () => {
      await store.set('agentPool.maxSize', 25)
      await store.set('taskHistory.maxEntries', 5000)
      const items = await store.list()
      const maxSize = items.find((i) => i.key === 'agentPool.maxSize')
      const history = items.find((i) => i.key === 'taskHistory.maxEntries')
      expect(maxSize?.current).to.equal(25)
      expect(history?.current).to.equal(5000)
    })
  })

  describe('reset', () => {
    it('removes the key from the file so list returns the default', async () => {
      await store.set('agentPool.maxSize', 25)
      await store.reset('agentPool.maxSize')

      const item = await store.get('agentPool.maxSize')
      expect(item.current).to.equal(item.default)
    })

    it('rejects unknown keys with UnknownSettingKeyError', async () => {
      try {
        await store.reset('not.a.real.key')
        expect.fail('expected throw')
      } catch (error) {
        expect(error).to.be.instanceOf(UnknownSettingKeyError)
      }
    })

    it('is a no-op when the key has no override', async () => {
      await store.reset('agentPool.maxSize')
      const item = await store.get('agentPool.maxSize')
      expect(item.current).to.equal(item.default)
    })

    it('preserves other overrides when resetting one key', async () => {
      await store.set('agentPool.maxSize', 25)
      await store.set('taskHistory.maxEntries', 5000)
      await store.reset('agentPool.maxSize')

      const items = await store.list()
      const maxSize = items.find((i) => i.key === 'agentPool.maxSize')
      const history = items.find((i) => i.key === 'taskHistory.maxEntries')
      expect(maxSize?.current).to.equal(maxSize?.default)
      expect(history?.current).to.equal(5000)
    })

    it('physically removes the key from the file even when its stored value is invalid', async () => {
      await writeFile(
        join(tempDir, SETTINGS_FILENAME),
        JSON.stringify({
          values: {
            'agentPool.maxSize': 'garbage',
            'taskHistory.maxEntries': 5000,
          },
          version: '1',
        }),
        'utf8',
      )

      await store.reset('agentPool.maxSize')

      const content = await readFile(join(tempDir, SETTINGS_FILENAME), 'utf8')
      const parsed: unknown = JSON.parse(content)
      const file = asSettingsFile(parsed)
      expect(file.values['agentPool.maxSize']).to.be.undefined
      expect(file.values['taskHistory.maxEntries']).to.equal(5000)
    })

    it('preserves OTHER invalid entries when resetting one key (does not wipe the whole file)', async () => {
      // Reset must not collateral-damage entries the user did not ask to touch.
      // The startup loader handles invalid entries via warnings; reset is scoped.
      await writeFile(
        join(tempDir, SETTINGS_FILENAME),
        JSON.stringify({
          values: {
            'agentPool.maxConcurrentTasksPerProject': 8,
            'agentPool.maxSize': 25,
            'taskHistory.maxEntries': 'garbage-not-a-number',
          },
          version: '1',
        }),
        'utf8',
      )

      await store.reset('agentPool.maxSize')

      const content = await readFile(join(tempDir, SETTINGS_FILENAME), 'utf8')
      const parsed: unknown = JSON.parse(content)
      const file = asSettingsFile(parsed)
      expect(file.values['agentPool.maxSize']).to.be.undefined
      expect(file.values['agentPool.maxConcurrentTasksPerProject']).to.equal(8)
      // The pre-existing invalid entry must NOT have been silently dropped.
      expect(file.values['taskHistory.maxEntries']).to.equal('garbage-not-a-number')
    })

    it('unlinks the file when resetting the only invalid entry', async () => {
      await writeFile(
        join(tempDir, SETTINGS_FILENAME),
        JSON.stringify({
          values: {'agentPool.maxSize': 'garbage'},
          version: '1',
        }),
        'utf8',
      )

      await store.reset('agentPool.maxSize')

      const files = await readdir(tempDir)
      expect(files.filter((f) => f === SETTINGS_FILENAME)).to.have.lengthOf(0)
    })
  })

  describe('file robustness', () => {
    it('returns defaults when the file is missing', async () => {
      const items = await store.list()
      for (const item of items) {
        expect(item.current).to.equal(item.default)
      }
    })

    it('returns defaults when the file is corrupt JSON', async () => {
      await writeFile(join(tempDir, SETTINGS_FILENAME), 'not json at all', 'utf8')
      const items = await store.list()
      for (const item of items) {
        expect(item.current).to.equal(item.default)
      }
    })

    it('returns defaults when the file is well-formed JSON but has the wrong shape', async () => {
      await writeFile(join(tempDir, SETTINGS_FILENAME), JSON.stringify(['not', 'an', 'object']), 'utf8')
      const items = await store.list()
      for (const item of items) {
        expect(item.current).to.equal(item.default)
      }
    })

    it('ignores invalid entries in the file and returns defaults for them', async () => {
      await writeFile(
        join(tempDir, SETTINGS_FILENAME),
        JSON.stringify({
          values: {
            'agentPool.maxSize': 'oops',
            'taskHistory.maxEntries': 5000,
          },
          version: '1',
        }),
        'utf8',
      )

      const items = await store.list()
      const maxSize = items.find((i) => i.key === 'agentPool.maxSize')
      const history = items.find((i) => i.key === 'taskHistory.maxEntries')
      expect(maxSize?.current).to.equal(maxSize?.default)
      expect(history?.current).to.equal(5000)
    })

    it('writes atomically: no temp file remains after a successful write', async () => {
      await store.set('agentPool.maxSize', 25)
      const files = await readdir(tempDir)
      expect(files.filter((f) => f.endsWith('.tmp'))).to.have.lengthOf(0)
    })

    it('readStartupSnapshot returns defaults when the file is missing', async () => {
      const snapshot = await store.readStartupSnapshot()
      expect(snapshot.values).to.deep.equal({})
      expect(snapshot.invalid).to.deep.equal([])
    })

    it('readStartupSnapshot returns valid entries and an empty invalid list when the file is fully valid', async () => {
      await store.set('agentPool.maxSize', 25)
      await store.set('taskHistory.maxEntries', 5000)
      const snapshot = await store.readStartupSnapshot()
      expect(snapshot.values).to.deep.equal({
        'agentPool.maxSize': 25,
        'taskHistory.maxEntries': 5000,
      })
      expect(snapshot.invalid).to.deep.equal([])
    })

    it('readStartupSnapshot returns valid entries and lists invalid entries for partial files', async () => {
      await writeFile(
        join(tempDir, SETTINGS_FILENAME),
        JSON.stringify({
          values: {
            'agentPool.maxSize': 'oops',
            'not.a.key': 7,
            'taskHistory.maxEntries': 5000,
          },
          version: '1',
        }),
        'utf8',
      )

      const snapshot = await store.readStartupSnapshot()
      expect(snapshot.values).to.deep.equal({'taskHistory.maxEntries': 5000})
      expect(snapshot.invalid).to.have.lengthOf(2)
      const invalidKeys = snapshot.invalid.map((i) => i.key).sort()
      expect(invalidKeys).to.deep.equal(['agentPool.maxSize', 'not.a.key'])
    })

    it('readStartupSnapshot surfaces parseError when the file is corrupt JSON', async () => {
      await writeFile(join(tempDir, SETTINGS_FILENAME), 'not json', 'utf8')
      const snapshot = await store.readStartupSnapshot()
      expect(snapshot.values).to.deep.equal({})
      expect(snapshot.invalid).to.deep.equal([])
      expect(snapshot.parseError).to.be.a('string')
    })

    it('readStartupSnapshot surfaces parseError when the top-level JSON is not an object', async () => {
      await writeFile(join(tempDir, SETTINGS_FILENAME), JSON.stringify(['arr']), 'utf8')
      const snapshot = await store.readStartupSnapshot()
      expect(snapshot.values).to.deep.equal({})
      expect(snapshot.parseError).to.be.a('string')
    })

    it('readStartupSnapshot returns no parseError when the file is missing', async () => {
      const snapshot = await store.readStartupSnapshot()
      expect(snapshot.parseError).to.be.undefined
    })

    it('leaves the file in a parseable state after concurrent writes (last-write-wins)', async () => {
      await Promise.all([
        store.set('agentPool.maxSize', 25),
        store.set('agentPool.maxConcurrentTasksPerProject', 8),
        store.set('taskHistory.maxEntries', 5000),
      ])

      const content = await readFile(join(tempDir, SETTINGS_FILENAME), 'utf8')
      const parsed: unknown = JSON.parse(content)
      const file = asSettingsFile(parsed)
      expect(file.version).to.be.a('string')
      expect(file.values).to.be.an('object')

      const files = await readdir(tempDir)
      expect(files.filter((f) => f.endsWith('.tmp'))).to.have.lengthOf(0)
    })
  })

  describe('schema migration (T2: v1 -> v2)', () => {
    const CURRENT_SCHEMA_VERSION = '2'

    it('writes the current schema version on a fresh set', async () => {
      await store.set('agentPool.maxSize', 25)
      const file = asSettingsFile(JSON.parse(await readFile(join(tempDir, SETTINGS_FILENAME), 'utf8')))
      expect(file.version).to.equal(CURRENT_SCHEMA_VERSION)
    })

    it('round-trips a boolean value (true, not 1) for update.checkForUpdates', async () => {
      await store.set('update.checkForUpdates', true)
      const item = await store.get('update.checkForUpdates')
      expect(item.current).to.equal(true)
      const file = asSettingsFile(JSON.parse(await readFile(join(tempDir, SETTINGS_FILENAME), 'utf8')))
      expect(file.values['update.checkForUpdates']).to.equal(true)
    })

    it('round-trips a boolean false value', async () => {
      await store.set('update.checkForUpdates', false)
      const item = await store.get('update.checkForUpdates')
      expect(item.current).to.equal(false)
    })

    it('migrates a pre-existing v1 file to v2 on first read, preserving every value', async () => {
      const v1Payload = {
        values: {
          'agentPool.maxConcurrentTasksPerProject': 4,
          'agentPool.maxSize': 25,
          'llm.iterationBudgetMs': 600_000,
        },
        version: '1',
      }
      await writeFile(join(tempDir, SETTINGS_FILENAME), JSON.stringify(v1Payload, null, 2), 'utf8')

      await store.list()

      const file = asSettingsFile(JSON.parse(await readFile(join(tempDir, SETTINGS_FILENAME), 'utf8')))
      expect(file.version).to.equal(CURRENT_SCHEMA_VERSION)
      expect(file.values).to.deep.equal(v1Payload.values)
    })

    it('does not rewrite the file on a second read once it is already v2 (idempotent)', async () => {
      // Trigger an initial migration so the file is v2 on disk.
      const v1Payload = {values: {'agentPool.maxSize': 25}, version: '1'}
      const path = join(tempDir, SETTINGS_FILENAME)
      await writeFile(path, JSON.stringify(v1Payload, null, 2), 'utf8')
      await store.list()

      // Snapshot mtime after migration, then read again and compare.
      const {readFile: readFileFs, stat} = await import('node:fs/promises')
      const afterMigration = await stat(path)
      const contentBeforeRead = await readFileFs(path, 'utf8')

      await store.list()

      const afterSecondRead = await stat(path)
      const contentAfterRead = await readFileFs(path, 'utf8')

      expect(afterSecondRead.mtimeMs, 'mtime must not change on a re-read of a v2 file').to.equal(afterMigration.mtimeMs)
      expect(contentAfterRead).to.equal(contentBeforeRead)
    })

    it('preserves pre-existing invalid entries through migration (does not collateral-damage)', async () => {
      // v1 file with a mix of valid and invalid entries. Migration must not
      // drop the invalid ones (per the existing reset() preservation rule).
      const v1Payload = {
        values: {
          'agentPool.maxSize': 25,
          'unknown.key': 'something',
        },
        version: '1',
      }
      await writeFile(join(tempDir, SETTINGS_FILENAME), JSON.stringify(v1Payload, null, 2), 'utf8')
      await store.list()

      const file = asSettingsFile(JSON.parse(await readFile(join(tempDir, SETTINGS_FILENAME), 'utf8')))
      expect(file.version).to.equal(CURRENT_SCHEMA_VERSION)
      expect(file.values).to.deep.equal(v1Payload.values)
    })
  })

  describe('readonly-info variant (M16.1)', () => {
    const readonlyInfoRegistry: readonly SettingDescriptor[] = [
      {
        category: 'updates',
        description: 'live operational snapshot for tests',
        key: '_test.snapshot',
        restartRequired: false,
        type: 'readonly-info',
      },
      {
        category: 'concurrency',
        default: 10,
        description: 'test writable',
        key: '_test.writable',
        max: 100,
        min: 1,
        restartRequired: true,
        type: 'integer',
      },
    ]

    let isolatedStore: FileSettingsStore
    let isolatedDir: string

    beforeEach(async () => {
      isolatedDir = join(tmpdir(), `brv-settings-roi-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      await mkdir(isolatedDir, {recursive: true})
      isolatedStore = new FileSettingsStore({
        baseDir: isolatedDir,
        registry: readonlyInfoRegistry,
        validator: new SettingsValidator({registry: readonlyInfoRegistry}),
      })
    })

    afterEach(async () => {
      await rm(isolatedDir, {force: true, recursive: true})
    })

    describe('set', () => {
      it('throws ReadonlySettingKeyError on a readonly-info key', async () => {
        try {
          await isolatedStore.set('_test.snapshot', 'whatever')
          expect.fail('expected throw')
        } catch (error) {
          expect(error).to.be.instanceOf(ReadonlySettingKeyError)
        }
      })

      it('does NOT create the settings file when refusing a readonly-info write', async () => {
        try {
          await isolatedStore.set('_test.snapshot', 'whatever')
        } catch {
          // expected
        }

        expect(existsSync(join(isolatedDir, SETTINGS_FILENAME))).to.equal(false)
      })

      it('does NOT mutate an existing settings file when refusing a readonly-info write', async () => {
        await isolatedStore.set('_test.writable', 25)
        const before = await readFile(join(isolatedDir, SETTINGS_FILENAME), 'utf8')

        try {
          await isolatedStore.set('_test.snapshot', 'whatever')
        } catch {
          // expected
        }

        const after = await readFile(join(isolatedDir, SETTINGS_FILENAME), 'utf8')
        expect(after).to.equal(before)
      })
    })

    describe('reset', () => {
      it('throws ReadonlySettingKeyError on a readonly-info key', async () => {
        try {
          await isolatedStore.reset('_test.snapshot')
          expect.fail('expected throw')
        } catch (error) {
          expect(error).to.be.instanceOf(ReadonlySettingKeyError)
        }
      })

      it('does NOT mutate the settings file when refusing a readonly-info reset', async () => {
        await isolatedStore.set('_test.writable', 25)
        const before = await readFile(join(isolatedDir, SETTINGS_FILENAME), 'utf8')

        try {
          await isolatedStore.reset('_test.snapshot')
        } catch {
          // expected
        }

        const after = await readFile(join(isolatedDir, SETTINGS_FILENAME), 'utf8')
        expect(after).to.equal(before)
      })
    })

    describe('get', () => {
      it('returns current=undefined and omits default for a readonly-info key', async () => {
        const item = await isolatedStore.get('_test.snapshot')
        expect(item.key).to.equal('_test.snapshot')
        expect(item.current).to.equal(undefined)
        expect(item.default).to.equal(undefined)
        expect(item.restartRequired).to.equal(false)
      })

      it('still returns descriptor defaults for writable keys alongside readonly-info', async () => {
        const item = await isolatedStore.get('_test.writable')
        expect(item.key).to.equal('_test.writable')
        expect(item.current).to.equal(10)
        expect(item.default).to.equal(10)
      })
    })

    describe('list', () => {
      it('includes the readonly-info row with current=undefined and default omitted', async () => {
        const items = await isolatedStore.list()
        const snapshot = items.find((i) => i.key === '_test.snapshot')
        expect(snapshot, 'readonly-info row must be present').to.exist
        expect(snapshot?.current).to.equal(undefined)
        expect(snapshot?.default).to.equal(undefined)
        expect(snapshot?.restartRequired).to.equal(false)
      })

      it('keeps writable rows unaffected by the readonly-info branch', async () => {
        const items = await isolatedStore.list()
        const writable = items.find((i) => i.key === '_test.writable')
        expect(writable?.current).to.equal(10)
        expect(writable?.default).to.equal(10)
      })
    })
  })
})

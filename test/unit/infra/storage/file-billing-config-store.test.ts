import {expect} from 'chai'
import {existsSync} from 'node:fs'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {FileBillingConfigStore} from '../../../../src/server/infra/storage/file-billing-config-store.js'

describe('FileBillingConfigStore', () => {
  let baseDir: string
  let configPath: string
  let store: FileBillingConfigStore

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'brv-billing-config-'))
    configPath = join(baseDir, 'brv-provider.json')
    store = new FileBillingConfigStore({baseDir})
  })

  afterEach(async () => {
    await rm(baseDir, {force: true, recursive: true})
  })

  describe('getPinnedTeamId', () => {
    it('returns undefined when the config file does not exist', async () => {
      expect(await store.getPinnedTeamId()).to.equal(undefined)
    })

    it('returns undefined when the file is corrupted', async () => {
      const {writeFile} = await import('node:fs/promises')
      await writeFile(configPath, '{not valid json', 'utf8')
      expect(await store.getPinnedTeamId()).to.equal(undefined)
    })

    it('returns the previously-written organization id', async () => {
      await store.setPinnedTeamId('org-123')
      expect(await store.getPinnedTeamId()).to.equal('org-123')
    })

    it('returns undefined after the pin is cleared', async () => {
      await store.setPinnedTeamId('org-123')
      await store.setPinnedTeamId(undefined)
      expect(await store.getPinnedTeamId()).to.equal(undefined)
    })
  })

  describe('setPinnedTeamId', () => {
    it('creates the base directory if it does not exist', async () => {
      const nestedDir = join(baseDir, 'nested')
      const nestedStore = new FileBillingConfigStore({baseDir: nestedDir})

      await nestedStore.setPinnedTeamId('org-1')

      expect(existsSync(join(nestedDir, 'brv-provider.json'))).to.equal(true)
    })

    it('persists pretty-printed JSON', async () => {
      await store.setPinnedTeamId('org-456')
      const content = await readFile(configPath, 'utf8')
      expect(content).to.contain('\n')
      expect(JSON.parse(content)).to.deep.equal({billing: {pinnedTeamId: 'org-456'}})
    })

    it('omits the field when cleared so the file stays minimal', async () => {
      await store.setPinnedTeamId('org-999')
      await store.setPinnedTeamId(undefined)
      const content = await readFile(configPath, 'utf8')
      expect(JSON.parse(content)).to.deep.equal({})
    })

    it('writes to the configured base directory, not a global path', async () => {
      const otherBase = await mkdtemp(join(tmpdir(), 'brv-billing-other-'))
      const otherStore = new FileBillingConfigStore({baseDir: otherBase})

      await store.setPinnedTeamId('org-A')
      await otherStore.setPinnedTeamId('org-B')

      expect(await store.getPinnedTeamId()).to.equal('org-A')
      expect(await otherStore.getPinnedTeamId()).to.equal('org-B')

      await rm(otherBase, {force: true, recursive: true})
    })
  })

})

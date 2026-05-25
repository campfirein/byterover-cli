
import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {ensureContextTreeGitignore} from '../../../../src/server/utils/gitignore.js'

/**
 * Phase 9.5.11 — verify `ensureContextTreeGitignore` writes the channel/
 * exclusion line so VC tree-replace operations cannot wipe
 * `.brv/context-tree/channel/<id>/meta.json`. See plan/bridge-smoothness/PHASE_9_5_11.md.
 */
describe('ensureContextTreeGitignore (Phase 9.5.11 — /channel/ exclusion)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'brv-gi-ch-'))
  })

  afterEach(async () => {
    await fs.rm(dir, {force: true, recursive: true})
  })

  it('writes /channel/ into a fresh .gitignore', async () => {
    await ensureContextTreeGitignore(dir)

    const contents = await fs.readFile(join(dir, '.gitignore'), 'utf8')
    expect(contents).to.match(/^\/channel\/$/m)
  })

  it('is idempotent — running twice does not duplicate the /channel/ line', async () => {
    await ensureContextTreeGitignore(dir)
    await ensureContextTreeGitignore(dir)

    const contents = await fs.readFile(join(dir, '.gitignore'), 'utf8')
    const matches = contents.match(/^\/channel\/$/gm) ?? []
    expect(matches).to.have.lengthOf(1)
  })

  it('appends /channel/ when the .gitignore exists without it (in-place upgrade)', async () => {
    const preExisting = '# Some user-authored gitignore\nmy-pattern\n'
    await fs.writeFile(join(dir, '.gitignore'), preExisting, 'utf8')

    await ensureContextTreeGitignore(dir)

    const contents = await fs.readFile(join(dir, '.gitignore'), 'utf8')
    expect(contents.startsWith(preExisting)).to.equal(true)
    expect(contents).to.match(/^\/channel\/$/m)
  })
})

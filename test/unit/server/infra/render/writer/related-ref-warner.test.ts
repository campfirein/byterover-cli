/**
 * related-ref warner tests.
 *
 * The warner is read-only and probes only the form the agent's suffix
 * picked: `.html` → file at `<ref>.html`, bare → folder at `<ref>/`.
 * A warning surfaces when that probed shape does not exist on disk.
 * The other on-disk shape is irrelevant — a `.html` ref pointing at a
 * folder (or a bare ref pointing at a file) is still a dead pill the
 * FE cannot route. The warner never mutates the attribute and never
 * rejects the write.
 */

import {expect} from 'chai'
import {chmodSync} from 'node:fs'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {computeRelatedWarnings} from '../../../../../../src/server/infra/render/writer/related-ref-warner.js'

async function seedFile(root: string, relPath: string): Promise<void> {
  const full = join(root, relPath)
  await mkdir(join(full, '..'), {recursive: true})
  await writeFile(full, '<bv-topic path="x" title="x"></bv-topic>', 'utf8')
}

async function seedFolder(root: string, relPath: string): Promise<void> {
  await mkdir(join(root, relPath), {recursive: true})
}

describe('related-ref warner', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'related-warner-'))
  })

  afterEach(async () => {
    await rm(tmpRoot, {force: true, recursive: true})
  })

  describe('no warnings', () => {
    it('returns [] when relatedAttr is undefined', () => {
      const result = computeRelatedWarnings({contextTreeRoot: tmpRoot, relatedAttr: undefined})
      expect(result).to.deep.equal([])
    })

    it('returns [] for an empty string', () => {
      const result = computeRelatedWarnings({contextTreeRoot: tmpRoot, relatedAttr: ''})
      expect(result).to.deep.equal([])
    })

    it('returns [] for whitespace-only', () => {
      const result = computeRelatedWarnings({contextTreeRoot: tmpRoot, relatedAttr: '   ,  ,   '})
      expect(result).to.deep.equal([])
    })

    it('returns [] for an explicit .html ref pointing at an existing file', async () => {
      await seedFile(tmpRoot, 'security/oauth.html')
      const result = computeRelatedWarnings({contextTreeRoot: tmpRoot, relatedAttr: '@security/oauth.html'})
      expect(result).to.deep.equal([])
    })

    it('returns [] for a bare ref pointing at an existing folder', async () => {
      await seedFolder(tmpRoot, 'ops')
      const result = computeRelatedWarnings({contextTreeRoot: tmpRoot, relatedAttr: '@ops'})
      expect(result).to.deep.equal([])
    })

    it('returns [] for multiple refs that all resolve cleanly', async () => {
      await seedFile(tmpRoot, 'security/oauth.html')
      await seedFolder(tmpRoot, 'ops')
      const result = computeRelatedWarnings({
        contextTreeRoot: tmpRoot,
        relatedAttr: '@security/oauth.html, @ops',
      })
      expect(result).to.deep.equal([])
    })

    it('accepts refs without the leading @ (permissive parsing)', async () => {
      await seedFolder(tmpRoot, 'ops')
      const result = computeRelatedWarnings({contextTreeRoot: tmpRoot, relatedAttr: 'ops'})
      expect(result).to.deep.equal([])
    })

    it('trims whitespace around comma-separated refs', async () => {
      await seedFolder(tmpRoot, 'ops')
      const result = computeRelatedWarnings({
        contextTreeRoot: tmpRoot,
        relatedAttr: '  @ops  ',
      })
      expect(result).to.deep.equal([])
    })
  })

  describe('broken refs', () => {
    it('warns when neither a file nor a folder exists at the ref path', () => {
      const result = computeRelatedWarnings({
        contextTreeRoot: tmpRoot,
        relatedAttr: '@security/missing',
      })
      expect(result).to.have.lengthOf(1)
      expect(result[0]).to.include('@security/missing')
      expect(result[0].toLowerCase()).to.match(/not found|no such|does not exist|broken/)
    })

    it('emits one warning per broken ref in a multi-ref attribute', async () => {
      await seedFile(tmpRoot, 'security/oauth.html')
      const result = computeRelatedWarnings({
        contextTreeRoot: tmpRoot,
        relatedAttr: '@security/oauth.html, @security/missing_a, @security/missing_b',
      })
      expect(result).to.have.lengthOf(2)
      expect(result.some((w) => w.includes('@security/missing_a'))).to.equal(true)
      expect(result.some((w) => w.includes('@security/missing_b'))).to.equal(true)
    })
  })

  describe('suffix mismatch (probe only the chosen form)', () => {
    // The reverse of the dropped "ambiguous" case: the agent's suffix
    // picks a form, the on-disk shape on the OTHER side is irrelevant.
    // Probing both forms would silently accept a dead-pill scenario
    // because the FE routes by suffix and would 404 either way.
    it('warns when an explicit .html ref points at a folder instead of a file', async () => {
      await seedFolder(tmpRoot, 'ops')
      const result = computeRelatedWarnings({contextTreeRoot: tmpRoot, relatedAttr: '@ops.html'})
      expect(result).to.have.lengthOf(1)
      expect(result[0]).to.include('@ops.html')
      expect(result[0].toLowerCase()).to.include('no file')
    })

    it('warns when a bare ref points at a file instead of a folder', async () => {
      await seedFile(tmpRoot, 'security/oauth.html')
      const result = computeRelatedWarnings({contextTreeRoot: tmpRoot, relatedAttr: '@security/oauth'})
      expect(result).to.have.lengthOf(1)
      expect(result[0]).to.include('@security/oauth')
      expect(result[0].toLowerCase()).to.include('no folder')
      // Coaching hint: a bare ref + only file present is the typical
      // "agent forgot the .html suffix" mistake — the warning must point
      // them at the fix.
      expect(result[0]).to.include('.html')
    })
  })

  describe('race-resilient', () => {
    it('treats stat-failures as "not present" instead of throwing (post-write must never surface as failure)', async () => {
      // A common TOCTOU shape: file is deleted between probing and statting,
      // or the parent directory loses read permission mid-curate. Before the
      // safeStat guard a thrown stat would bubble out of writeHtmlTopic and
      // turn a successful curate into a reported failure even though the
      // topic is already on disk. The warner stays advisory: any stat error
      // is treated as "not present" so the ref simply surfaces as broken.
      await mkdir(join(tmpRoot, 'locked'), {recursive: true})
      chmodSync(join(tmpRoot, 'locked'), 0)
      try {
        const result = computeRelatedWarnings({
          contextTreeRoot: tmpRoot,
          relatedAttr: '@locked/whatever',
        })
        expect(result).to.have.lengthOf(1)
        expect(result[0]).to.include('@locked/whatever')
        expect(result[0].toLowerCase()).to.match(/not found|no such|does not exist/)
      } finally {
        chmodSync(join(tmpRoot, 'locked'), 0o755)
      }
    })
  })

  describe('safety', () => {
    it('refuses to escape the context-tree root via .. segments', () => {
      const result = computeRelatedWarnings({
        contextTreeRoot: tmpRoot,
        relatedAttr: '@../etc/passwd',
      })
      // Treated as unsafe — surfaces a warning, never touches the filesystem
      // outside the root.
      expect(result).to.have.lengthOf(1)
      expect(result[0].toLowerCase()).to.match(/unsafe|invalid|traversal/)
    })

    it('refuses a ref that is only "."', () => {
      const result = computeRelatedWarnings({
        contextTreeRoot: tmpRoot,
        relatedAttr: '@./foo',
      })
      expect(result).to.have.lengthOf(1)
      expect(result[0].toLowerCase()).to.match(/unsafe|invalid|traversal/)
    })
  })
})

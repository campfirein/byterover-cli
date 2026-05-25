
import {expect} from 'chai'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {
  type BuildInfo,
  compareBuildIds,
  formatMismatchWarning,
  isBuildInfo,
  readBuildInfoSync,
} from '../../../src/shared/build-info-check.js'

// Phase 9.5.9 §2.1 — unit tests for the pure build-info-check utilities.
// These cover the shared/ layer only (no transport, no oclif, no server).

describe('build-info-check (shared)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'brv-bic-'))
  })

  afterEach(() => {
    rmSync(tmpDir, {force: true, recursive: true})
  })

  // ─── isBuildInfo ────────────────────────────────────────────────────────

  describe('isBuildInfo()', () => {
    it('returns true for a valid BuildInfo object', () => {
      const bi: BuildInfo = {
        buildAtIso: '2026-05-24T14:14:00.000Z',
        buildId: '2026-05-24T14:14:00.000Z-abc1234-clean',
        gitDirty: false,
        gitSha: 'abc1234',
        packageVersion: '3.15.1',
      }
      expect(isBuildInfo(bi)).to.equal(true)
    })

    it('returns false when buildId is missing', () => {
      expect(isBuildInfo({buildAtIso: 'x', packageVersion: '1.0.0'})).to.equal(false)
    })

    it('returns false for null or non-object', () => {
      expect(isBuildInfo(null)).to.equal(false)
      expect(isBuildInfo('string')).to.equal(false)
      expect(isBuildInfo(42)).to.equal(false)
    })
  })

  // ─── compareBuildIds ────────────────────────────────────────────────────

  describe('compareBuildIds()', () => {
    it('match: returns {match: true} when buildIds are identical', () => {
      const id = '2026-05-24T14:14:00.000Z-abc1234-clean'
      expect(compareBuildIds(id, id)).to.deep.equal({match: true})
    })

    it('mismatch: returns {match: false} with both ids when they differ', () => {
      const a = '2026-05-24T08:45:00.000Z-111aaaa-clean'
      const b = '2026-05-24T14:14:00.000Z-abc1234-clean'
      const result = compareBuildIds(a, b)
      expect(result.match).to.equal(false)
      if (!result.match) {
        expect(result.daemonBuildId).to.equal(a)
        expect(result.cliBuildId).to.equal(b)
      }
    })
  })

  // ─── readBuildInfoSync ──────────────────────────────────────────────────

  describe('readBuildInfoSync()', () => {
    it('returns BuildInfo from a valid JSON file', () => {
      const bi: BuildInfo = {
        buildAtIso: '2026-05-24T14:14:00.000Z',
        buildId: '2026-05-24T14:14:00.000Z-abc1234-clean',
        gitDirty: false,
        gitSha: 'abc1234',
        packageVersion: '3.15.1',
      }
      writeFileSync(join(tmpDir, 'build-info.json'), JSON.stringify(bi), 'utf8')
      const result = readBuildInfoSync(join(tmpDir, 'build-info.json'))
      expect(result).to.deep.equal(bi)
    })

    it('returns undefined when the file does not exist (graceful)', () => {
      const result = readBuildInfoSync(join(tmpDir, 'nonexistent.json'))
      expect(result).to.equal(undefined)
    })

    it('returns undefined when the file contains invalid JSON', () => {
      writeFileSync(join(tmpDir, 'build-info.json'), 'not-json{', 'utf8')
      const result = readBuildInfoSync(join(tmpDir, 'build-info.json'))
      expect(result).to.equal(undefined)
    })

    it('returns undefined when the JSON object lacks required buildId field', () => {
      writeFileSync(join(tmpDir, 'build-info.json'), JSON.stringify({buildAtIso: 'x'}), 'utf8')
      const result = readBuildInfoSync(join(tmpDir, 'build-info.json'))
      expect(result).to.equal(undefined)
    })
  })

  // ─── formatMismatchWarning ──────────────────────────────────────────────

  describe('formatMismatchWarning()', () => {
    it('includes both buildIds in the returned string', () => {
      const daemon = '2026-05-24T08:45:00.000Z-111aaaa-clean'
      const cli = '2026-05-24T14:14:00.000Z-abc1234-clean'
      const msg = formatMismatchWarning({cliBuildId: cli, daemonBuildId: daemon})
      expect(msg).to.include(daemon)
      expect(msg).to.include(cli)
      expect(msg).to.include('brv restart')
    })
  })
})

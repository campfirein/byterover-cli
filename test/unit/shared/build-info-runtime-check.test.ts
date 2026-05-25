
import {expect} from 'chai'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {
  assertBuildVersionMatch,
  type BuildInfoResponse,
} from '../../../src/shared/build-info-check.js'

/**
 * Phase 9.5.9 Issue 5 — runtime build-version mismatch detection.
 *
 * assertBuildVersionMatch compares the daemon's buildId (returned by
 * system:build-info) against the CLI's own buildId (from dist/build-info.json).
 * On mismatch it prints a warning to stderr exactly once. On match it is silent.
 * When build-info.json is missing, it degrades gracefully (no crash, no warning).
 *
 * These tests FAIL before the helper is added to shared/build-info-check.ts.
 */

describe('assertBuildVersionMatch (Issue 5 — runtime build-info check)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'brv-bic-rt-'))
  })

  afterEach(() => {
    rmSync(tmpDir, {force: true, recursive: true})
  })

  it('prints a mismatch warning to the provided output function when buildIds differ', async () => {
    const cliInfoPath = join(tmpDir, 'build-info.json')
    writeFileSync(cliInfoPath, JSON.stringify({
      buildAtIso: '2026-05-24T14:14:00.000Z',
      buildId: '2026-05-24T14:14:00.000Z-newbuild-clean',
      packageVersion: '3.15.1',
    }), 'utf8')

    const daemonResponse: BuildInfoResponse = {
      buildId: '2026-05-24T08:45:00.000Z-oldbuild-clean',
    }

    const warnings: string[] = []
    const printWarning = (msg: string): void => { warnings.push(msg) }

    await assertBuildVersionMatch({
      buildInfoPath: cliInfoPath,
      daemonBuildInfo: daemonResponse,
      printWarning,
    })

    expect(warnings.length).to.be.greaterThan(0)
    expect(warnings[0]).to.include('oldbuild')
    expect(warnings[0]).to.include('newbuild')
    expect(warnings[0]).to.include('brv restart')
  })

  it('does NOT print a warning when buildIds match', async () => {
    const cliInfoPath = join(tmpDir, 'build-info.json')
    const sameBuildId = '2026-05-24T14:14:00.000Z-abc1234-clean'
    writeFileSync(cliInfoPath, JSON.stringify({
      buildAtIso: '2026-05-24T14:14:00.000Z',
      buildId: sameBuildId,
      packageVersion: '3.15.1',
    }), 'utf8')

    const daemonResponse: BuildInfoResponse = {buildId: sameBuildId}

    const warnings: string[] = []
    const printWarning = (msg: string): void => { warnings.push(msg) }

    await assertBuildVersionMatch({
      buildInfoPath: cliInfoPath,
      daemonBuildInfo: daemonResponse,
      printWarning,
    })

    expect(warnings.length).to.equal(0)
  })

  it('degrades gracefully (no warning, no throw) when CLI build-info.json is missing', async () => {
    const daemonResponse: BuildInfoResponse = {
      buildId: '2026-05-24T08:45:00.000Z-oldbuild-clean',
    }

    const warnings: string[] = []
    const printWarning = (msg: string): void => { warnings.push(msg) }

    let threw = false
    try {
      await assertBuildVersionMatch({
        buildInfoPath: join(tmpDir, 'nonexistent-build-info.json'),
        daemonBuildInfo: daemonResponse,
        printWarning,
      })
    } catch {
      threw = true
    }

    expect(threw).to.equal(false)
    expect(warnings.length).to.equal(0)
  })

  it('degrades gracefully when daemon returns no buildId', async () => {
    const cliInfoPath = join(tmpDir, 'build-info.json')
    writeFileSync(cliInfoPath, JSON.stringify({
      buildAtIso: '2026-05-24T14:14:00.000Z',
      buildId: '2026-05-24T14:14:00.000Z-abc1234-clean',
      packageVersion: '3.15.1',
    }), 'utf8')

    const warnings: string[] = []
    const printWarning = (msg: string): void => { warnings.push(msg) }

    let threw = false
    try {
      await assertBuildVersionMatch({
        buildInfoPath: cliInfoPath,
        daemonBuildInfo: undefined,
        printWarning,
      })
    } catch {
      threw = true
    }

    expect(threw).to.equal(false)
    expect(warnings.length).to.equal(0)
  })
})

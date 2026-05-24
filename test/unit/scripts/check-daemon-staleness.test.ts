
import {expect} from 'chai'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {checkDaemonStaleness, type StalenessCheckResult} from '../../../scripts/check-daemon-staleness.js'

// Phase 9.5.9 §2.2 — unit tests for the daemon-staleness postbuild check.
// The implementation must be pure + injectable so tests do NOT touch real
// pid checks or live daemon.json files.

describe('checkDaemonStaleness()', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'brv-staleness-'))
  })

  afterEach(() => {
    rmSync(tmpDir, {force: true, recursive: true})
  })

  const NOW_MS = Date.now()

  // ─── No daemon.json → silent ─────────────────────────────────────────

  it('returns {stale: false} when daemon.json does not exist', () => {
    const result = checkDaemonStaleness({
      buildAtMs: NOW_MS,
      daemonJsonPath: join(tmpDir, 'nonexistent.json'),
      isProcessAlive: () => false,
      nowMs: NOW_MS,
    })
    expect(result.stale).to.equal(false)
  })

  // ─── Dead PID → silent ──────────────────────────────────────────────

  it('returns {stale: false} when the PID is not alive', () => {
    const startedAt = new Date(NOW_MS - 120_000).toISOString()
    writeFileSync(
      join(tmpDir, 'daemon.json'),
      JSON.stringify({pid: 99_999, port: 4000, startedAt}),
      'utf8',
    )
    const result = checkDaemonStaleness({
      buildAtMs: NOW_MS,
      daemonJsonPath: join(tmpDir, 'daemon.json'),
      isProcessAlive: () => false,
      nowMs: NOW_MS,
    })
    expect(result.stale).to.equal(false)
  })

  // ─── Alive PID newer than build → silent ────────────────────────────

  it('returns {stale: false} when daemon started AFTER the build', () => {
    const startedAt = new Date(NOW_MS + 5000).toISOString() // 5s after build
    writeFileSync(
      join(tmpDir, 'daemon.json'),
      JSON.stringify({pid: 12_345, port: 4000, startedAt}),
      'utf8',
    )
    const result = checkDaemonStaleness({
      buildAtMs: NOW_MS,
      daemonJsonPath: join(tmpDir, 'daemon.json'),
      isProcessAlive: (_pid: number) => true,
      nowMs: NOW_MS + 10_000,
    })
    expect(result.stale).to.equal(false)
  })

  // ─── Alive PID older than build → warns ─────────────────────────────

  it('returns {stale: true} when daemon started before the build AND pid is alive', () => {
    const startedAt = new Date(NOW_MS - 120_000).toISOString() // 2 min before build
    writeFileSync(
      join(tmpDir, 'daemon.json'),
      JSON.stringify({pid: 12_128, port: 4000, startedAt}),
      'utf8',
    )
    const result = checkDaemonStaleness({
      buildAtMs: NOW_MS,
      daemonJsonPath: join(tmpDir, 'daemon.json'),
      isProcessAlive: (_pid: number) => true,
      nowMs: NOW_MS + 5000,
    }) as StalenessCheckResult & {stale: true}
    expect(result.stale).to.equal(true)
    expect(result.pid).to.equal(12_128)
    expect(result.startedAt).to.equal(startedAt)
  })

  it('returns {stale: false} for malformed daemon.json', () => {
    writeFileSync(join(tmpDir, 'daemon.json'), 'not-json', 'utf8')
    const result = checkDaemonStaleness({
      buildAtMs: NOW_MS,
      daemonJsonPath: join(tmpDir, 'daemon.json'),
      isProcessAlive: () => true,
      nowMs: NOW_MS,
    })
    expect(result.stale).to.equal(false)
  })
})

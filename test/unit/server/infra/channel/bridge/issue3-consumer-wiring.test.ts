
import {expect} from 'chai'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {createAutoCreateQuota} from '../../../../../../src/server/infra/channel/bridge/auto-create-quota.js'
import {createDefaultRegistry} from '../../../../../../src/server/infra/channel/bridge/parley-adapter-registry.js'
import {createFileBackedSessionStore} from '../../../../../../src/server/infra/channel/bridge/parley-adapter-session-store.js'
import {createProfileConcurrencyGate} from '../../../../../../src/server/infra/channel/bridge/profile-concurrency-gate.js'

/**
 * Phase 9.5.9 Issue 3 — verify consumer wiring.
 *
 * 3a. createDefaultRegistry accepts bridgeClaudeUnsafe flag from persisted config
 *     (not only env).
 * 3b. createAutoCreateQuota accepts maxPerHour from persisted config.
 *
 * These tests FAIL before the fix because the registry only reads env.
 */

describe('Issue 3 — consumer wiring for persisted bridge config fields', () => {
  const logs: string[] = []
  const log = (msg: string): number => logs.push(msg)

  beforeEach(() => { logs.length = 0 })

  // ─── 3a: registry registers claude-code when persistedClaudeUnsafe=true ──

  describe('3a: createDefaultRegistry — persistedClaudeUnsafe flag', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'brv-registry-3a-'))
    })

    afterEach(() => {
      rmSync(tmpDir, {force: true, recursive: true})
    })

    it('registers claude-code when persistedClaudeUnsafe=true even with env unset', async () => {
      const gate = createProfileConcurrencyGate({maxConcurrent: 1})
      const store = createFileBackedSessionStore({filePath: join(tmpDir, 'sessions.json'), log() {}})

      // env has NO BRV_BRIDGE_CLAUDE_UNSAFE — but persistedClaudeUnsafe=true
      const registry = createDefaultRegistry({
        concurrencyGate: gate,
        env: {},               // env unset
        log,
        persistedClaudeUnsafe: true,  // persisted value
        sessionStore: store,
      })

      const adapter = registry.resolve('claude-code')
      expect(adapter, 'claude-code must register when persistedClaudeUnsafe=true').to.not.equal(undefined)
      expect(adapter!.kind).to.equal('sdk-headless')
    })

    it('does NOT register claude-code when both env and persisted are falsy', async () => {
      const gate = createProfileConcurrencyGate({maxConcurrent: 1})
      const store = createFileBackedSessionStore({filePath: join(tmpDir, 'sessions.json'), log() {}})

      const registry = createDefaultRegistry({
        concurrencyGate: gate,
        env: {},
        log,
        persistedClaudeUnsafe: false,
        sessionStore: store,
      })

      expect(registry.resolve('claude-code')).to.equal(undefined)
    })

    it('env BRV_BRIDGE_CLAUDE_UNSAFE=1 takes precedence over persistedClaudeUnsafe=false', async () => {
      const gate = createProfileConcurrencyGate({maxConcurrent: 1})
      const store = createFileBackedSessionStore({filePath: join(tmpDir, 'sessions.json'), log() {}})

      // env wins even if persisted says false
      const registry = createDefaultRegistry({
        concurrencyGate: gate,
        env: {BRV_BRIDGE_CLAUDE_UNSAFE: '1'},
        log,
        persistedClaudeUnsafe: false,
        sessionStore: store,
      })

      const adapter = registry.resolve('claude-code')
      expect(adapter, 'env=1 must win over persisted=false').to.not.equal(undefined)
    })
  })

  // ─── 3b: createAutoCreateQuota accepts maxPerHour from persisted config ───

  describe('3b: createAutoCreateQuota — persisted maxPerHour', () => {
    it('uses the provided maxPerHour argument (persisted from bridge-config)', () => {
      // maxPerHour arg already existed in createAutoCreateQuota; this test
      // verifies that passing it (from bridgeRuntime.autoCreateQuota) works
      // correctly and is not ignored in favour of env or default.
      const quota = createAutoCreateQuota({log, maxPerHour: 3})
      const now = new Date()
      expect(quota.tryConsume({now, peerId: 'peer-1'})).to.equal(true)
      expect(quota.tryConsume({now, peerId: 'peer-1'})).to.equal(true)
      expect(quota.tryConsume({now, peerId: 'peer-1'})).to.equal(true)
      // 4th attempt should be denied (limit is 3)
      expect(quota.tryConsume({now, peerId: 'peer-1'})).to.equal(false)
    })

    it('default limit (5) applies when maxPerHour is undefined and env unset', () => {
      // Back up and clear the env var so the default path is tested.
      const backup = process.env.BRV_BRIDGE_AUTO_CREATE_QUOTA
      delete process.env.BRV_BRIDGE_AUTO_CREATE_QUOTA

      try {
        const quota = createAutoCreateQuota({log})
        const now = new Date()
        for (let i = 0; i < 5; i++) {
          expect(quota.tryConsume({now, peerId: 'peer-def'})).to.equal(true)
        }

        expect(quota.tryConsume({now, peerId: 'peer-def'})).to.equal(false)
      } finally {
        if (backup !== undefined) process.env.BRV_BRIDGE_AUTO_CREATE_QUOTA = backup
      }
    })
  })

  // ─── 3b (RemoteMemberDriver): persisted dial timeout used when env absent ─

  describe('3b: RemoteMemberDriver — persistedTimeouts used when env absent', () => {
    it('accepts persistedTimeouts in constructor without TypeScript error', async () => {
      const {RemoteMemberDriver} = await import('../../../../../../src/server/infra/channel/bridge/remote-member-driver.js')
      // Just confirm the type compiles — persistedTimeouts must exist in RemoteMemberDriverDeps.
      const driver = new RemoteMemberDriver({
        async _sendParleyQuery() {
          throw new Error('not called')
        },
        channelId: 'ch-1',
        handle: '@bob',
        host: {} as never,
        install: {} as never,
        l2Identity: {} as never,
        multiaddr: '/ip4/127.0.0.1/tcp/9000',
        peerId: 'peer-1',
        persistedTimeouts: {dialTimeoutMs: 45_000, idleTimeoutMs: 90_000},
        remoteL2PubKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      })
      expect(driver).to.not.equal(undefined)
    })
  })
})

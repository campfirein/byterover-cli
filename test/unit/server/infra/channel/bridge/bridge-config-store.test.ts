 
import {expect} from 'chai'
import {existsSync, readFileSync} from 'node:fs'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {
  BRIDGE_CONFIG_FILE,
  BridgeConfigStore,
  resolveBridgeRuntimeConfig,
} from '../../../../../../src/server/infra/channel/bridge/bridge-config-store.js'

// Internal-test hardening (2026-05-20) — `bridge-config-store.ts`
// closes the silent-degradation hole where a daemon respawn that lost
// `BRV_BRIDGE_PARLEY_PROFILE` would fall back to mock-echo. Tests cover
// the three operational paths:
//
//   1. Env var supplies a value → resolver returns it AND persists to file
//   2. File has a previous value, no env in scope → resolver returns the
//      file value (the respawn-recovery path the team will exercise)
//   3. Env and file disagree → env wins, file is updated to the env value

describe('BridgeConfigStore + resolveBridgeRuntimeConfig (post-merge hardening)', () => {
  let stateDir: string
  const logs: string[] = []
  const log = (msg: string): number => logs.push(msg)

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'brv-bridge-config-'))
    logs.length = 0
  })

  afterEach(async () => {
    await rm(stateDir, {force: true, recursive: true})
  })

  describe('BridgeConfigStore', () => {
    it('load() returns an empty object when no file exists', () => {
      const store = new BridgeConfigStore({stateDir})
      expect(store.load()).to.deep.equal({})
    })

    it('load() returns {} when the file is malformed JSON', async () => {
      const store = new BridgeConfigStore({stateDir})
      await writeFile(store.filePath, 'not json{{{', 'utf8')
      expect(store.load()).to.deep.equal({})
    })

    it('load() returns {} when the file fails schema validation', async () => {
      const store = new BridgeConfigStore({stateDir})
      await writeFile(store.filePath, JSON.stringify({autoProvision: 'bogus'}), 'utf8')
      expect(store.load()).to.deep.equal({})
    })

    it('save() writes an atomically-renamed file with the validated config', async () => {
      const store = new BridgeConfigStore({stateDir})
      store.save({autoProvision: 'auto', maxConcurrentPerProfile: 4, parleyProfile: 'codex'})
      expect(existsSync(store.filePath)).to.equal(true)
      const raw = JSON.parse(readFileSync(store.filePath, 'utf8')) as Record<string, unknown>
      expect(raw.parleyProfile).to.equal('codex')
      expect(raw.autoProvision).to.equal('auto')
      expect(raw.maxConcurrentPerProfile).to.equal(4)
    })

    it('save() round-trips through load() without surprises', () => {
      const store = new BridgeConfigStore({stateDir})
      const cfg = {
        autoProvision: 'auto' as const,
        delegatePolicy: 'prompt' as const,
        maxConcurrentPerProfile: 2,
        parleyProfile: 'kimi',
        projectRoot: '/Users/me/proj',
      }
      store.save(cfg)
      expect(store.load()).to.deep.equal(cfg)
    })
  })

  describe('resolveBridgeRuntimeConfig — env-supplied path', () => {
    it('returns env values + persists them to file for future respawns', () => {
      const store = new BridgeConfigStore({stateDir})
      const result = resolveBridgeRuntimeConfig({
        cwd: () => '/cwd',
        env: {
          BRV_BRIDGE_AUTO_PROVISION: 'auto',
          BRV_BRIDGE_MAX_CONCURRENT_PER_PROFILE: '3',
          BRV_BRIDGE_PARLEY_PROFILE: 'codex',
        },
        log,
        store,
      })
      expect(result.parleyProfile).to.equal('codex')
      expect(result.autoProvision).to.equal('auto')
      expect(result.maxConcurrentPerProfile).to.equal(3)

      // Persisted to file so a respawn without env still inherits.
      expect(existsSync(store.filePath)).to.equal(true)
      const onDisk = store.load()
      expect(onDisk).to.deep.equal({
        autoProvision: 'auto',
        maxConcurrentPerProfile: 3,
        parleyProfile: 'codex',
      })
      expect(logs.some((m) => m.includes('Bridge config persisted'))).to.equal(true)
    })

    it('invalid env values log and fall through to file/default', () => {
      const store = new BridgeConfigStore({stateDir})
      const result = resolveBridgeRuntimeConfig({
        cwd: () => '/cwd',
        env: {BRV_BRIDGE_AUTO_PROVISION: 'totally-bogus', BRV_BRIDGE_MAX_CONCURRENT_PER_PROFILE: 'notanumber'},
        log,
        store,
      })
      expect(result.autoProvision).to.equal('pinned-only')
      expect(result.maxConcurrentPerProfile).to.equal(1)
      expect(logs.some((m) => m.includes('invalid BRV_BRIDGE_AUTO_PROVISION'))).to.equal(true)
      expect(logs.some((m) => m.includes('invalid BRV_BRIDGE_MAX_CONCURRENT_PER_PROFILE'))).to.equal(true)
    })
  })

  describe('resolveBridgeRuntimeConfig — file-supplied path (the respawn-recovery fix)', () => {
    it('reads previously-persisted values when env is absent', () => {
      const store = new BridgeConfigStore({stateDir})
      store.save({
        autoProvision: 'auto',
        delegatePolicy: 'auto',
        maxConcurrentPerProfile: 4,
        parleyProfile: 'codex',
        projectRoot: '/persisted-proj',
      })
      const result = resolveBridgeRuntimeConfig({cwd: () => '/cwd', env: {}, log, store})
      expect(result.parleyProfile).to.equal('codex')
      expect(result.autoProvision).to.equal('auto')
      expect(result.delegatePolicy).to.equal('auto')
      expect(result.maxConcurrentPerProfile).to.equal(4)
      expect(result.projectRoot).to.equal('/persisted-proj')
    })

    it('does not re-persist when nothing in env supplied a value (avoid no-op writes)', () => {
      const store = new BridgeConfigStore({stateDir})
      store.save({parleyProfile: 'codex'})
      const contentBefore = readFileSync(store.filePath, 'utf8')
      resolveBridgeRuntimeConfig({cwd: () => '/cwd', env: {}, log, store})
      const contentAfter = readFileSync(store.filePath, 'utf8')
      // File content unchanged
      expect(contentAfter).to.equal(contentBefore)
      expect(logs.filter((m) => m.includes('Bridge config persisted'))).to.have.lengthOf(0)
    })
  })

  describe('resolveBridgeRuntimeConfig — precedence (env > file > default)', () => {
    it('env overrides file when both are present and they disagree', () => {
      const store = new BridgeConfigStore({stateDir})
      store.save({autoProvision: 'pinned-only', parleyProfile: 'kimi'})
      const result = resolveBridgeRuntimeConfig({
        cwd: () => '/cwd',
        env: {BRV_BRIDGE_AUTO_PROVISION: 'auto', BRV_BRIDGE_PARLEY_PROFILE: 'codex'},
        log,
        store,
      })
      expect(result.autoProvision).to.equal('auto')
      expect(result.parleyProfile).to.equal('codex')
      // File reflects the new env-supplied posture for future respawns.
      const onDisk = store.load()
      expect(onDisk.autoProvision).to.equal('auto')
      expect(onDisk.parleyProfile).to.equal('codex')
    })

    it('defaults apply when neither env nor file specifies a value', () => {
      const store = new BridgeConfigStore({stateDir})
      const result = resolveBridgeRuntimeConfig({cwd: () => '/specific-cwd', env: {}, log, store})
      expect(result.autoProvision).to.equal('pinned-only')
      expect(result.delegatePolicy).to.equal('prompt')
      expect(result.maxConcurrentPerProfile).to.equal(1)
      expect(result.parleyProfile).to.equal(undefined)
      expect(result.projectRoot).to.equal('/specific-cwd')
    })
  })

  it('exports the canonical config filename so callers don\'t hand-roll the path', () => {
    expect(BRIDGE_CONFIG_FILE).to.equal('bridge-config.json')
  })

  describe('listenAddrs — cross-machine bridge configurability', () => {
    it('parses BRV_BRIDGE_LISTEN_ADDRS as comma-separated multiaddrs', () => {
      const store = new BridgeConfigStore({stateDir})
      const result = resolveBridgeRuntimeConfig({
        cwd: () => '/cwd',
        env: {BRV_BRIDGE_LISTEN_ADDRS: '/ip4/0.0.0.0/tcp/60001,/ip4/100.84.167.73/tcp/60001'},
        log,
        store,
      })
      expect(result.listenAddrs).to.deep.equal([
        '/ip4/0.0.0.0/tcp/60001',
        '/ip4/100.84.167.73/tcp/60001',
      ])
      // Persisted so daemon respawns inherit:
      const onDisk = store.load()
      expect(onDisk.listenAddrs).to.deep.equal([
        '/ip4/0.0.0.0/tcp/60001',
        '/ip4/100.84.167.73/tcp/60001',
      ])
    })

    it('ignores empty / whitespace-only entries in the comma list', () => {
      const store = new BridgeConfigStore({stateDir})
      const result = resolveBridgeRuntimeConfig({
        cwd: () => '/cwd',
        env: {BRV_BRIDGE_LISTEN_ADDRS: '/ip4/0.0.0.0/tcp/60001, , /ip4/100.x/tcp/60001 ,'},
        log,
        store,
      })
      expect(result.listenAddrs).to.deep.equal([
        '/ip4/0.0.0.0/tcp/60001',
        '/ip4/100.x/tcp/60001',
      ])
    })

    it('returns undefined when env + file are both empty (caller falls back to DEFAULT_BRIDGE_CONFIG)', () => {
      const store = new BridgeConfigStore({stateDir})
      const result = resolveBridgeRuntimeConfig({cwd: () => '/cwd', env: {}, log, store})
      expect(result.listenAddrs).to.equal(undefined)
    })

    it('reads previously-persisted listenAddrs when env is absent (respawn recovery)', () => {
      const store = new BridgeConfigStore({stateDir})
      store.save({listenAddrs: ['/ip4/0.0.0.0/tcp/60001']})
      const result = resolveBridgeRuntimeConfig({cwd: () => '/cwd', env: {}, log, store})
      expect(result.listenAddrs).to.deep.equal(['/ip4/0.0.0.0/tcp/60001'])
    })

    it('env overrides file when both are present', () => {
      const store = new BridgeConfigStore({stateDir})
      store.save({listenAddrs: ['/ip4/127.0.0.1/tcp/0']})
      const result = resolveBridgeRuntimeConfig({
        cwd: () => '/cwd',
        env: {BRV_BRIDGE_LISTEN_ADDRS: '/ip4/0.0.0.0/tcp/60001'},
        log,
        store,
      })
      expect(result.listenAddrs).to.deep.equal(['/ip4/0.0.0.0/tcp/60001'])
      // File reflects the new env-supplied value for future respawns.
      expect(store.load().listenAddrs).to.deep.equal(['/ip4/0.0.0.0/tcp/60001'])
    })
  })
})

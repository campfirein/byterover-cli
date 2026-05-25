import {expect} from 'chai'
import {mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {DEFAULT_TARGET_PATHS, HOST_TO_PATH, install, resolveBrvBin, resolveTargets} from '../bin/install-lib.js'

// Slice 8.2 — install CLI for the brv-channel skill. Writes SKILL.md
// to the canonical agent-skill discovery paths so all five hosts
// (Claude Code, Codex, kimi-cli, opencode, Pi) pick up the same file.

describe('channel-skill install (Slice 8.2)', () => {
  let workDir: string
  let skillSource: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'brv-channel-skill-test-'))
    skillSource = join(workDir, 'SKILL.md')
    writeFileSync(skillSource, '# test skill body\n', 'utf8')
  })

  afterEach(() => {
    rmSync(workDir, {force: true, recursive: true})
  })

  const targetPath = (host: 'claude' | 'codex' | 'pi'): string => {
    const home = join(workDir, 'home')
    mkdirSync(home, {recursive: true})
    return join(home, HOST_TO_PATH[host])
  }

  describe('HOST_TO_PATH mapping', () => {
    it('maps each host to a unique sub-path under $HOME', () => {
      expect(HOST_TO_PATH.claude).to.match(/\.claude\/skills\/brv-channel\/SKILL\.md$/)
      expect(HOST_TO_PATH.codex).to.match(/\.codex\/skills\/brv-channel\/SKILL\.md$/)
      expect(HOST_TO_PATH.pi).to.match(/\.agents\/skills\/brv-channel\/SKILL\.md$/)
    })

    it('DEFAULT_TARGET_PATHS covers all three canonical hosts', () => {
      expect(DEFAULT_TARGET_PATHS).to.have.lengthOf(3)
    })
  })

  describe('resolveTargets', () => {
    it('all → three default paths', () => {
      const resolved = resolveTargets({homeDir: workDir, target: 'all'})
      expect(resolved).to.have.lengthOf(3)
      for (const path of resolved) expect(path.startsWith(workDir)).to.equal(true)
    })

    it('claude → one path', () => {
      const resolved = resolveTargets({homeDir: workDir, target: 'claude'})
      expect(resolved).to.have.lengthOf(1)
      expect(resolved[0]).to.match(/\.claude\/skills\/brv-channel\/SKILL\.md$/)
    })

    it('explicit --path overrides --target', () => {
      const custom = join(workDir, 'custom', 'SKILL.md')
      const resolved = resolveTargets({customPath: custom, homeDir: workDir, target: 'all'})
      expect(resolved).to.deep.equal([custom])
    })

    it('rejects an unknown --target', () => {
      expect(() => resolveTargets({homeDir: workDir, target: 'fake-host'})).to.throw(/unknown target/i)
    })
  })

  describe('install (write semantics)', () => {
    it('writes the skill to a single target path, creating parent dirs', async () => {
      const target = targetPath('claude')
      const result = await install({skillSource, targets: [target]})
      expect(result.written).to.deep.equal([target])
      expect(result.skipped).to.deep.equal([])
      expect(readFileSync(target, 'utf8')).to.equal('# test skill body\n')
    })

    it('writes to multiple target paths in one call', async () => {
      const t1 = targetPath('claude')
      const t2 = targetPath('codex')
      const result = await install({skillSource, targets: [t1, t2]})
      expect(result.written).to.have.lengthOf(2)
      expect(existsSync(t1)).to.equal(true)
      expect(existsSync(t2)).to.equal(true)
    })

    it('dry-run does NOT write but reports the planned paths', async () => {
      const target = targetPath('claude')
      const result = await install({dryRun: true, skillSource, targets: [target]})
      expect(result.written).to.deep.equal([target])
      expect(existsSync(target)).to.equal(false)
    })

    it('idempotent — re-run with identical contents skips', async () => {
      const target = targetPath('claude')
      await install({skillSource, targets: [target]})
      const result = await install({skillSource, targets: [target]})
      expect(result.skipped).to.deep.equal([target])
      expect(result.written).to.deep.equal([])
    })

    it('refuses to overwrite a different existing file unless --force', async () => {
      const target = targetPath('claude')
      mkdirSync(join(workDir, 'home', '.claude', 'skills', 'brv-channel'), {recursive: true})
      writeFileSync(target, '# OLD CONTENT\n', 'utf8')

      let caught: unknown
      try {
        await install({skillSource, targets: [target]})
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(Error)
      expect((caught as Error).message).to.match(/--force/i)
      expect(readFileSync(target, 'utf8')).to.equal('# OLD CONTENT\n')
    })

    it('--force overwrites a different existing file', async () => {
      const target = targetPath('claude')
      mkdirSync(join(workDir, 'home', '.claude', 'skills', 'brv-channel'), {recursive: true})
      writeFileSync(target, '# OLD CONTENT\n', 'utf8')

      const result = await install({force: true, skillSource, targets: [target]})
      expect(result.written).to.deep.equal([target])
      expect(readFileSync(target, 'utf8')).to.equal('# test skill body\n')
    })

    it('throws when skillSource is missing', async () => {
      let caught: unknown
      try {
        await install({skillSource: join(workDir, 'no-such-file.md'), targets: [targetPath('claude')]})
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(Error)
      expect((caught as Error).message).to.match(/SKILL\.md/i)
    })
  })

  describe('resolveBrvBin', () => {
    it('returns the explicit override when supplied', () => {
      expect(resolveBrvBin({brvBin: '/explicit/brv'})).to.equal('/explicit/brv')
    })

    it('falls back to BRV_BIN env var when no override', () => {
      const original = process.env.BRV_BIN
      process.env.BRV_BIN = '/env/brv'
      try {
        expect(resolveBrvBin()).to.equal('/env/brv')
      } finally {
        if (original === undefined) delete process.env.BRV_BIN
        else process.env.BRV_BIN = original
      }
    })

    it('walks PATH when env+override are absent', () => {
      const fakeDir = join(workDir, 'fake-bin')
      mkdirSync(fakeDir, {recursive: true})
      const brvPath = join(fakeDir, 'brv')
      writeFileSync(brvPath, '#!/bin/sh\nexit 0\n', {encoding: 'utf8', mode: 0o755})

      const original = process.env.BRV_BIN
      delete process.env.BRV_BIN
      try {
        const resolved = resolveBrvBin({pathEnv: fakeDir})
        expect(resolved).to.equal(brvPath)
      } finally {
        if (original !== undefined) process.env.BRV_BIN = original
      }
    })

    it('falls back to literal "brv" when nothing resolves', () => {
      const original = process.env.BRV_BIN
      delete process.env.BRV_BIN
      try {
        expect(resolveBrvBin({pathEnv: '/nonexistent-dir-for-test'})).to.equal('brv')
      } finally {
        if (original !== undefined) process.env.BRV_BIN = original
      }
    })
  })

  describe('install ({{BRV_BIN}} substitution)', () => {
    beforeEach(() => {
      writeFileSync(
        skillSource,
        'Run `{{BRV_BIN}} channel list` to see channels.\nThen `{{BRV_BIN}} channel mention …`.\n',
        'utf8',
      )
    })

    it('replaces every {{BRV_BIN}} occurrence with the resolved path', async () => {
      const target = targetPath('claude')
      const result = await install({brvBin: '/abs/brv', skillSource, targets: [target]})
      expect(result.brvBin).to.equal('/abs/brv')
      const body = readFileSync(target, 'utf8')
      expect(body).to.contain('Run `/abs/brv channel list`')
      expect(body).to.contain('`/abs/brv channel mention …`')
      expect(body).to.not.contain('{{BRV_BIN}}')
    })

    it('returns the resolved brv path in the result for caller logging', async () => {
      const result = await install({brvBin: '/some/brv', skillSource, targets: [targetPath('claude')]})
      expect(result.brvBin).to.equal('/some/brv')
    })

    it('idempotency still works after substitution', async () => {
      const target = targetPath('claude')
      await install({brvBin: '/abs/brv', skillSource, targets: [target]})
      const second = await install({brvBin: '/abs/brv', skillSource, targets: [target]})
      expect(second.skipped).to.deep.equal([target])
      expect(second.written).to.deep.equal([])
    })

    it('different brvBin counts as different content (triggers --force prompt)', async () => {
      const target = targetPath('claude')
      await install({brvBin: '/abs/brv-one', skillSource, targets: [target]})
      let caught: unknown
      try {
        await install({brvBin: '/abs/brv-two', skillSource, targets: [target]})
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(Error)
      expect((caught as Error).message).to.match(/--force/i)
    })
  })
})

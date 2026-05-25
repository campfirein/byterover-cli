import type {Config} from '@oclif/core'

import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import sinon, {restore, stub} from 'sinon'

import ChannelSkillInstall from '../../../src/oclif/commands/channel/skill/install.js'

const SKILL_BODY = '---\nname: brv-channel\ndescription: test\n---\n\n# body\n\nbinary={{BRV_BIN}}\n'

class TestableChannelSkillInstall extends ChannelSkillInstall {
  public constructor(
    argv: string[],
    private readonly overrides: {homeDir: string; skillSource: string},
    config: Config,
  ) {
    super(argv, config)
  }

  protected override resolveHomeDir(): string {
    return this.overrides.homeDir
  }

  protected override resolveSkillSource(): string {
    return this.overrides.skillSource
  }
}

describe('Channel Skill Install Command (oclif)', () => {
  let config: Config
  let workDir: string
  let homeDir: string
  let skillSource: string
  let logged: string[]
  let stdoutChunks: string[]
  let writeStub: sinon.SinonStub | undefined

  before(async () => {
    config = await OclifConfig.load(import.meta.url)
  })

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'brv-channel-skill-cmd-'))
    homeDir = join(workDir, 'home')
    skillSource = join(workDir, 'SKILL.md')
    writeFileSync(skillSource, SKILL_BODY, 'utf8')
    logged = []
    stdoutChunks = []
  })

  afterEach(() => {
    if (writeStub !== undefined) {
      writeStub.restore()
      writeStub = undefined
    }

    restore()
    rmSync(workDir, {force: true, recursive: true})
  })

  const makeCommand = (argv: string[]): TestableChannelSkillInstall => {
    const cmd = new TestableChannelSkillInstall(argv, {homeDir, skillSource}, config)
    stub(cmd, 'log').callsFake((msg?: string) => {
      if (msg !== undefined) logged.push(msg)
    })
    return cmd
  }

  const makeJsonCommand = (argv: string[]): TestableChannelSkillInstall => {
    const cmd = makeCommand(['--format', 'json', ...argv])
    writeStub = stub(process.stdout, 'write').callsFake((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk))
      return true
    })
    return cmd
  }

  const claudePath = (): string => join(homeDir, '.claude/skills/brv-channel/SKILL.md')
  const codexPath = (): string => join(homeDir, '.codex/skills/brv-channel/SKILL.md')
  const agentsPath = (): string => join(homeDir, '.agents/skills/brv-channel/SKILL.md')

  describe('default install (text format)', () => {
    it('writes the skill to all three default host paths', async () => {
      const cmd = makeCommand(['--brv-bin', '/test/brv'])
      await cmd.run()

      expect(existsSync(claudePath())).to.equal(true)
      expect(existsSync(codexPath())).to.equal(true)
      expect(existsSync(agentsPath())).to.equal(true)
    })

    it('substitutes {{BRV_BIN}} with the resolved binary path', async () => {
      const cmd = makeCommand(['--brv-bin', '/test/brv'])
      await cmd.run()

      const body = readFileSync(claudePath(), 'utf8')
      expect(body).to.include('binary=/test/brv')
      expect(body).to.not.include('{{BRV_BIN}}')
    })

    it('logs the baked brv binary path', async () => {
      const cmd = makeCommand(['--brv-bin', '/test/brv'])
      await cmd.run()

      const joined = logged.join('\n')
      expect(joined).to.include('/test/brv')
    })
  })

  describe('--target', () => {
    it('--target claude writes only the claude path', async () => {
      const cmd = makeCommand(['--target', 'claude', '--brv-bin', '/test/brv'])
      await cmd.run()

      expect(existsSync(claudePath())).to.equal(true)
      expect(existsSync(codexPath())).to.equal(false)
      expect(existsSync(agentsPath())).to.equal(false)
    })

    it('--target kimi aliases onto the claude path', async () => {
      const cmd = makeCommand(['--target', 'kimi', '--brv-bin', '/test/brv'])
      await cmd.run()

      expect(existsSync(claudePath())).to.equal(true)
    })

    it('--target pi writes the .agents/skills path', async () => {
      const cmd = makeCommand(['--target', 'pi', '--brv-bin', '/test/brv'])
      await cmd.run()

      expect(existsSync(agentsPath())).to.equal(true)
      expect(existsSync(claudePath())).to.equal(false)
    })
  })

  describe('--path override', () => {
    it('--path writes to the explicit absolute path', async () => {
      const custom = join(workDir, 'custom/brv-channel/SKILL.md')
      const cmd = makeCommand(['--path', custom, '--brv-bin', '/test/brv'])
      await cmd.run()

      expect(existsSync(custom)).to.equal(true)
      expect(existsSync(claudePath())).to.equal(false)
    })
  })

  describe('--dry-run', () => {
    it('--dry-run does not write to disk', async () => {
      const cmd = makeCommand(['--dry-run', '--brv-bin', '/test/brv'])
      await cmd.run()

      expect(existsSync(claudePath())).to.equal(false)
      expect(existsSync(codexPath())).to.equal(false)
      expect(existsSync(agentsPath())).to.equal(false)
    })

    it('--dry-run still logs the planned paths', async () => {
      const cmd = makeCommand(['--dry-run', '--brv-bin', '/test/brv'])
      await cmd.run()

      const joined = logged.join('\n')
      expect(joined).to.match(/dry-run/i)
    })
  })

  describe('--force', () => {
    it('without --force, re-running with different content errors', async () => {
      // First install at /test/brv …
      await makeCommand(['--brv-bin', '/test/brv']).run()
      // … then re-install with a *different* brv-bin → contents differ.
      const cmd = makeCommand(['--brv-bin', '/other/brv'])
      let threw: unknown
      try {
        await cmd.run()
      } catch (error) {
        threw = error
      }

      expect(threw).to.not.equal(undefined)
    })

    it('--force overwrites differing content', async () => {
      await makeCommand(['--brv-bin', '/test/brv']).run()
      const cmd = makeCommand(['--brv-bin', '/other/brv', '--force'])
      await cmd.run()

      expect(readFileSync(claudePath(), 'utf8')).to.include('binary=/other/brv')
    })

    it('idempotent — re-running with identical content reports unchanged', async () => {
      await makeCommand(['--brv-bin', '/test/brv']).run()
      logged.length = 0
      await makeCommand(['--brv-bin', '/test/brv']).run()

      const joined = logged.join('\n')
      expect(joined).to.match(/unchanged/i)
    })
  })

  describe('--format json', () => {
    it('emits a single JSON line with the install result', async () => {
      const cmd = makeJsonCommand(['--brv-bin', '/test/brv'])
      await cmd.run()

      const output = stdoutChunks.join('')
      const parsed = JSON.parse(output.trim())
      expect(parsed.success).to.equal(true)
      expect(parsed.command).to.equal('channel skill install')
      expect(parsed.data).to.have.property('brvBin', '/test/brv')
      expect(parsed.data).to.have.property('written')
      expect(Array.isArray(parsed.data.written)).to.equal(true)
      expect(parsed.data.written).to.have.lengthOf(3)
    })
  })
})

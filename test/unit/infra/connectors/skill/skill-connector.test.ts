import {expect} from 'chai'
import {mkdir, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'

import {AGENT_CONNECTOR_CONFIG} from '../../../../../src/server/core/domain/entities/agent.js'
import {
  BRV_SKILL_NAME,
  SKILL_CONNECTOR_CONFIGS,
  SKILL_FILE_NAMES,
} from '../../../../../src/server/infra/connectors/skill/skill-connector-config.js'
import {SkillConnector} from '../../../../../src/server/infra/connectors/skill/skill-connector.js'
import {FsFileService} from '../../../../../src/server/infra/file/fs-file-service.js'

const EXPECTED_SUPPORTED_AGENTS = Object.entries(AGENT_CONNECTOR_CONFIG)
  .filter(([agent, config]) => agent in SKILL_CONNECTOR_CONFIGS && config.supported.includes('skill'))
  .map(([agent]) => agent)

describe('SkillConnector', () => {
  let testDir: string
  let fileService: FsFileService
  let skillConnector: SkillConnector

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `brv-skill-test-${Date.now()}`)
    await mkdir(testDir, {recursive: true})
    fileService = new FsFileService()
    skillConnector = new SkillConnector({
      fileService,
      projectRoot: testDir,
    })
  })

  afterEach(async () => {
    await rm(testDir, {force: true, recursive: true})
  })

  describe('connectorType', () => {
    it('should have type "skill"', () => {
      expect(skillConnector.connectorType).to.equal('skill')
    })
  })

  describe('getSupportedAgents', () => {
    it('should return agents that support skill connector', () => {
      const agents = skillConnector.getSupportedAgents()
      expect(agents).to.include('Claude Code')
      expect(agents).to.include('Cursor')
      expect(agents).to.include('Codex')
      expect(agents).to.include('Github Copilot')
      expect(agents).to.have.lengthOf(EXPECTED_SUPPORTED_AGENTS.length)
    })
  })

  describe('isSupported', () => {
    it('should return true for Claude Code', () => {
      expect(skillConnector.isSupported('Claude Code')).to.be.true
    })

    it('should return false for unsupported agents', () => {
      expect(skillConnector.isSupported('Augment Code')).to.be.false
      expect(skillConnector.isSupported('Claude Desktop')).to.be.false
      expect(skillConnector.isSupported('Cline')).to.be.false
      expect(skillConnector.isSupported('Qwen Code')).to.be.false
    })
  })

  describe('getConfigPath', () => {
    it('should return base path for Claude Code', () => {
      expect(skillConnector.getConfigPath('Claude Code')).to.equal(`.claude/skills/${BRV_SKILL_NAME}`)
    })

    it('should throw for unsupported agent', () => {
      expect(() => skillConnector.getConfigPath('Augment Code')).to.throw(
        'Skill connector does not support agent: Augment Code',
      )
    })
  })

  describe('install', () => {
    it('should create all three skill files for Claude Code', async () => {
      const agent = 'Claude Code' as const
      const {projectPath} = SKILL_CONNECTOR_CONFIGS[agent]
      const result = await skillConnector.install(agent)

      expect(result.success).to.be.true
      expect(result.alreadyInstalled).to.be.false

      const skillDir = path.join(projectPath, BRV_SKILL_NAME)
      const contents = await Promise.all(
        SKILL_FILE_NAMES.map((fileName) => readFile(path.join(testDir, skillDir, fileName), 'utf8')),
      )
      for (const content of contents) {
        expect(content).to.be.a('string')
        expect(content.length).to.be.greaterThan(0)
      }
    })

    it('should return alreadyInstalled if skill files exist', async () => {
      const agent = 'Claude Code' as const
      // First install
      await skillConnector.install(agent)

      // Second install
      const result = await skillConnector.install(agent)

      expect(result.success).to.be.true
      expect(result.alreadyInstalled).to.be.true
    })

    it('should return failure for unsupported agent', async () => {
      const result = await skillConnector.install('Augment Code')

      expect(result.success).to.be.false
      expect(result.message).to.include('does not support agent')
    })

    it('should create SKILL.md with frontmatter', async () => {
      const agent = 'Claude Code' as const
      const {projectPath} = SKILL_CONNECTOR_CONFIGS[agent]
      await skillConnector.install(agent)

      const skillDir = path.join(projectPath, BRV_SKILL_NAME)
      const skillContent = await readFile(path.join(testDir, skillDir, 'SKILL.md'), 'utf8')
      expect(skillContent).to.include('name: byterover')
      expect(skillContent).to.include('description:')
    })

    it('should create SKILL.md with brv curate view in Quick Reference and When to Use', async () => {
      const agent = 'Claude Code' as const
      const {projectPath} = SKILL_CONNECTOR_CONFIGS[agent]
      await skillConnector.install(agent)

      const skillDir = path.join(projectPath, BRV_SKILL_NAME)
      const content = await readFile(path.join(testDir, skillDir, 'SKILL.md'), 'utf8')
      expect(content).to.include('You MUST use this for gathering contexts before any work')
      expect(content).to.include('Runs locally with no LLM provider required')
    })
  })

  describe('status', () => {
    it('should return installed false if files do not exist', async () => {
      const agent = 'Claude Code' as const
      const result = await skillConnector.status(agent)

      expect(result.installed).to.be.false
      expect(result.configExists).to.be.false
    })

    it('should return installed true if SKILL.md exists', async () => {
      const agent = 'Claude Code' as const
      const {projectPath} = SKILL_CONNECTOR_CONFIGS[agent]
      await skillConnector.install(agent)

      const result = await skillConnector.status(agent)

      expect(result.installed).to.be.true
      expect(result.configExists).to.be.true
      expect(result.configPath).to.equal(path.join(projectPath, BRV_SKILL_NAME))
    })

    it('should return error status for unsupported agent', async () => {
      const result = await skillConnector.status('Augment Code')

      expect(result.installed).to.be.false
      expect(result.configExists).to.be.false
      expect(result.error).to.be.a('string')
      expect(result.error).to.include('does not support agent')
    })
  })

  describe('uninstall', () => {
    it('should return wasInstalled false if not installed', async () => {
      const result = await skillConnector.uninstall('Claude Code')

      expect(result.success).to.be.true
      expect(result.wasInstalled).to.be.false
    })

    it('should remove skill directory when installed', async () => {
      const agent = 'Claude Code' as const
      const {projectPath} = SKILL_CONNECTOR_CONFIGS[agent]
      await skillConnector.install(agent)

      const result = await skillConnector.uninstall(agent)

      expect(result.success).to.be.true
      expect(result.wasInstalled).to.be.true
      expect(result.configPath).to.equal(path.join(projectPath, BRV_SKILL_NAME))

      // Verify files are gone
      const skillDir = path.join(projectPath, BRV_SKILL_NAME)
      const existResults = await Promise.all(
        SKILL_FILE_NAMES.map((fileName) => fileService.exists(path.join(testDir, skillDir, fileName))),
      )
      for (const exists of existResults) {
        expect(exists).to.be.false
      }
    })

    it('should return failure for unsupported agent', async () => {
      const result = await skillConnector.uninstall('Augment Code')

      expect(result.success).to.be.false
      expect(result.message).to.include('does not support agent')
    })
  })

  describe('writeSkillFiles', () => {
    it('should write files to agent skill directory with custom name', async () => {
      const files = [
        {content: '# My Skill', name: 'SKILL.md'},
        {content: '# Readme', name: 'README.md'},
      ]
      const result = await skillConnector.writeSkillFiles('Claude Code', 'my-hub-skill', files)

      expect(result.alreadyInstalled).to.be.false
      expect(result.installedPath).to.equal(path.join(testDir, '.claude/skills/my-hub-skill'))
      expect(result.installedFiles).to.have.lengthOf(2)

      const skillContent = await readFile(path.join(testDir, '.claude/skills/my-hub-skill/SKILL.md'), 'utf8')
      expect(skillContent).to.equal('# My Skill')

      const readmeContent = await readFile(path.join(testDir, '.claude/skills/my-hub-skill/README.md'), 'utf8')
      expect(readmeContent).to.equal('# Readme')
    })

    it('should return alreadyInstalled if first file exists', async () => {
      const files = [{content: '# Skill', name: 'SKILL.md'}]

      // First write
      await skillConnector.writeSkillFiles('Claude Code', 'existing-skill', files)

      // Second write
      const result = await skillConnector.writeSkillFiles('Claude Code', 'existing-skill', files)

      expect(result.alreadyInstalled).to.be.true
      expect(result.installedFiles).to.have.lengthOf(0)
    })

    it('should throw for unsupported agent', async () => {
      const files = [{content: '# Skill', name: 'SKILL.md'}]

      try {
        await skillConnector.writeSkillFiles('Augment Code', 'my-skill', files)
        expect.fail('Should have thrown')
      } catch (error) {
        expect((error as Error).message).to.include('does not support agent')
      }
    })

    it('should write to correct directory for Cursor', async () => {
      const files = [{content: '# Cursor Skill', name: 'SKILL.md'}]
      const result = await skillConnector.writeSkillFiles('Cursor', 'cursor-skill', files)

      expect(result.installedPath).to.equal(path.join(testDir, '.cursor/skills/cursor-skill'))

      const content = await readFile(path.join(testDir, '.cursor/skills/cursor-skill/SKILL.md'), 'utf8')
      expect(content).to.equal('# Cursor Skill')
    })
  })

  describe('full lifecycle', () => {
    it('should support install → status → uninstall → status cycle', async () => {
      const agent = 'Claude Code' as const

      // Initially not installed
      const status1 = await skillConnector.status(agent)
      expect(status1.installed).to.be.false

      // Install
      const installResult = await skillConnector.install(agent)
      expect(installResult.success).to.be.true

      // Now installed
      const status2 = await skillConnector.status(agent)
      expect(status2.installed).to.be.true

      // Uninstall
      const uninstallResult = await skillConnector.uninstall(agent)
      expect(uninstallResult.success).to.be.true
      expect(uninstallResult.wasInstalled).to.be.true

      // Back to not installed
      const status3 = await skillConnector.status(agent)
      expect(status3.installed).to.be.false
    })
  })
})

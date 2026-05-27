import {expect} from 'chai'
import {mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises'
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
      homeDir: testDir,
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

  describe('managed skill files', () => {
    it('should enumerate every skill template markdown file', async () => {
      const templateFileNames = (await readdir(path.resolve('src/server/templates/skill')))
        .filter((fileName) => fileName.endsWith('.md'))
        .sort()

      expect([...SKILL_FILE_NAMES].sort()).to.deep.equal(templateFileNames)
    })
  })

  describe('getSupportedAgents', () => {
    it('should return agents that support skill connector', () => {
      const agents = skillConnector.getSupportedAgents()
      expect(agents).to.include('Claude Code')
      expect(agents).to.include('Cursor')
      expect(agents).to.include('Codex')
      expect(agents).to.include('Github Copilot')
      expect(agents).to.include('Hermes')
      expect(agents).to.include('OpenClaw')
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

    it('should return the resolved root for custom-root agents (Hermes under HERMES_HOME)', () => {
      const hermesHome = path.join(testDir, 'hermes-home')
      const connector = createConnector({env: {...process.env, HERMES_HOME: hermesHome}})

      expect(connector.getConfigPath('Hermes')).to.equal(path.join(hermesHome, 'skills', BRV_SKILL_NAME))
    })
  })

  describe('install', () => {
    it('should create all ByteRover skill files for Claude Code', async () => {
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
      expect(content).to.include('QUERY BEFORE THINKING. CURATE AFTER IMPLEMENTING.')
      expect(content).to.include('brv query')
      expect(content).to.include('brv curate')
      expect(content).to.include('brv curate view')
      expect(content).to.include('## When To Use')
      expect(content).to.include('## Quick Reference')
      expect(content).not.to.include('<<<<<<<')
      expect(content).not.to.include('=======')
      expect(content).not.to.include('>>>>>>>')
    })

    it('should create sibling query and swarm docs that describe parallel retrieval', async () => {
      const agent = 'Claude Code' as const
      const {projectPath} = SKILL_CONNECTOR_CONFIGS[agent]
      await skillConnector.install(agent)

      const skillDir = path.join(testDir, projectPath, BRV_SKILL_NAME)
      const queryContent = await readFile(path.join(skillDir, 'query.md'), 'utf8')
      const swarmContent = await readFile(path.join(skillDir, 'swarm.md'), 'utf8')

      expect(queryContent).to.include('brv query')
      expect(queryContent).to.include('brv swarm query')
      expect(queryContent).to.include('parallel')
      expect(swarmContent).to.include('brv query')
      expect(swarmContent).to.include('brv swarm query')
      expect(swarmContent).to.include('parallel')
    })

    it('should create curate.md documenting the session protocol and bv-topic contract', async () => {
      const agent = 'Claude Code' as const
      const {projectPath} = SKILL_CONNECTOR_CONFIGS[agent]
      await skillConnector.install(agent)

      const skillDir = path.join(testDir, projectPath, BRV_SKILL_NAME)
      const curateContent = await readFile(path.join(skillDir, 'curate.md'), 'utf8')

      expect(curateContent).to.include('--session')
      expect(curateContent).to.include('--response')
      expect(curateContent).to.include('needs-llm-step')
      expect(curateContent).to.include('<bv-topic')
      expect(curateContent).to.include('bv-rule')
      expect(curateContent).to.include('--overwrite')
    })

    it('should create sibling guides with When-To and Common Mistakes sections', async () => {
      const agent = 'Claude Code' as const
      const {projectPath} = SKILL_CONNECTOR_CONFIGS[agent]
      await skillConnector.install(agent)

      const skillDir = path.join(testDir, projectPath, BRV_SKILL_NAME)
      const [queryContent, reviewContent, swarmContent, vcContent, historyContent] = await Promise.all([
        readFile(path.join(skillDir, 'query.md'), 'utf8'),
        readFile(path.join(skillDir, 'review.md'), 'utf8'),
        readFile(path.join(skillDir, 'swarm.md'), 'utf8'),
        readFile(path.join(skillDir, 'vc.md'), 'utf8'),
        readFile(path.join(skillDir, 'history.md'), 'utf8'),
      ])

      expect(queryContent).to.include('## Common Mistakes')
      expect(reviewContent).to.include('## When To Review')
      expect(reviewContent).to.include('## Common Mistakes')
      expect(swarmContent).to.include('## When To Use Swarm')
      expect(swarmContent).to.include('## Common Mistakes')
      expect(vcContent).to.include('## When To Use VC')
      expect(vcContent).to.include('## Common Mistakes')
      expect(historyContent).to.include('## When To Inspect History')
      expect(historyContent).to.include('## Common Mistakes')
    })

    it('should create and deploy troubleshooting.md with error and privacy guidance', async () => {
      const agent = 'Claude Code' as const
      const {projectPath} = SKILL_CONNECTOR_CONFIGS[agent]
      await skillConnector.install(agent)

      const skillDir = path.join(testDir, projectPath, BRV_SKILL_NAME)
      const troubleshootingContent = await readFile(path.join(skillDir, 'troubleshooting.md'), 'utf8')

      expect(troubleshootingContent).to.include('Not authenticated')
      expect(troubleshootingContent).to.include('brv login')
      expect(troubleshootingContent).to.include('Maximum 5 files')
      expect(troubleshootingContent).to.include('does NOT invoke any LLM')
    })

    it('should inject the OpenClaw block into the default agent workspace (agents.defaults.workspace), not the agentDir', async () => {
      const openClawStateDir = path.join(testDir, 'openclaw-state')
      const openClawConfigPath = path.join(openClawStateDir, 'openclaw.json')
      const workspaceDir = path.join(testDir, 'oc-workspace')
      await mkdir(openClawStateDir, {recursive: true})
      await writeFile(
        openClawConfigPath,
        JSON.stringify({agents: {defaults: {model: {primary: 'x'}, workspace: workspaceDir}}}, null, 2),
        'utf8',
      )
      const connector = createConnector({
        env: {
          ...process.env,
          OPENCLAW_CONFIG_PATH: openClawConfigPath,
          OPENCLAW_STATE_DIR: openClawStateDir,
        },
      })

      const result = await connector.install('OpenClaw')

      expect(result.success).to.be.true
      const skillContent = await readFile(path.join(openClawStateDir, 'skills', BRV_SKILL_NAME, 'SKILL.md'), 'utf8')
      expect(skillContent).to.include('name: byterover')

      const wsAgents = await readFile(path.join(workspaceDir, 'AGENTS.md'), 'utf8')
      expect(wsAgents).to.include('<!-- BEGIN BYTEROVER RULES -->')
      expect(wsAgents).to.include('brv query')
      expect(wsAgents).to.include('brv swarm query')

      // The agentDir is OpenClaw internal state, never read for bootstrap — must NOT be written.
      expect(await fileService.exists(path.join(openClawStateDir, 'agents', 'main', 'agent', 'AGENTS.md'))).to.be.false
    })

    it('should fall back to ~/.openclaw/workspace for the default agent when no workspace is configured', async () => {
      const openClawStateDir = path.join(testDir, 'openclaw-state')
      const openClawConfigPath = path.join(openClawStateDir, 'openclaw.json')
      await mkdir(openClawStateDir, {recursive: true})
      await writeFile(openClawConfigPath, JSON.stringify({agents: {defaults: {}}}, null, 2), 'utf8')
      const connector = createConnector({
        env: {
          ...process.env,
          OPENCLAW_CONFIG_PATH: openClawConfigPath,
          OPENCLAW_STATE_DIR: openClawStateDir,
        },
      })

      const result = await connector.install('OpenClaw')

      expect(result.success).to.be.true
      // resolveDefaultAgentWorkspaceDir is home-based (~/.openclaw/workspace), NOT under OPENCLAW_STATE_DIR.
      const wsAgents = await readFile(path.join(testDir, '.openclaw', 'workspace', 'AGENTS.md'), 'utf8')
      expect(wsAgents).to.include('<!-- BEGIN BYTEROVER RULES -->')
      expect(wsAgents).to.include('brv swarm query')
    })

    it('should resolve listed agents by workspace (explicit, default fallback, and allowed subagents)', async () => {
      const openClawStateDir = path.join(testDir, 'openclaw-state')
      const openClawConfigPath = path.join(openClawStateDir, 'openclaw.json')
      const defaultsWs = path.join(testDir, 'oc-default-ws')
      const subWs = path.join(testDir, 'oc-sub-ws')
      await mkdir(openClawStateDir, {recursive: true})
      await writeFile(
        openClawConfigPath,
        JSON.stringify(
          {
            agents: {
              defaults: {workspace: defaultsWs},
              list: [
                {id: 'main', subagents: {allowAgents: ['research']}},
                {id: 'my-sub-agent', name: 'my-sub-agent', workspace: subWs},
              ],
            },
          },
          null,
          2,
        ),
        'utf8',
      )
      const connector = createConnector({
        env: {
          ...process.env,
          OPENCLAW_CONFIG_PATH: openClawConfigPath,
          OPENCLAW_STATE_DIR: openClawStateDir,
        },
      })

      const result = await connector.install('OpenClaw')

      expect(result.success).to.be.true
      const contents = await Promise.all(
        [
          path.join(defaultsWs, 'AGENTS.md'), // main = default agent → agents.defaults.workspace
          path.join(subWs, 'AGENTS.md'), // my-sub-agent → its explicit workspace
          path.join(defaultsWs, 'research', 'AGENTS.md'), // allowed subagent, no entry → <defaults.workspace>/<id>
        ].map((p) => readFile(p, 'utf8')),
      )
      for (const content of contents) {
        expect(content).to.include('<!-- BEGIN BYTEROVER RULES -->')
        expect(content).to.include('brv swarm query')
      }
    })

    it('should refresh and remove the OpenClaw managed block in the resolved workspace', async () => {
      const openClawStateDir = path.join(testDir, 'openclaw-state')
      const openClawConfigPath = path.join(openClawStateDir, 'openclaw.json')
      const workspaceDir = path.join(testDir, 'oc-workspace')
      const agentFile = path.join(workspaceDir, 'AGENTS.md')
      await mkdir(openClawStateDir, {recursive: true})
      await writeFile(
        openClawConfigPath,
        JSON.stringify({agents: {defaults: {workspace: workspaceDir}}}, null, 2),
        'utf8',
      )
      const connector = createConnector({
        env: {
          ...process.env,
          OPENCLAW_CONFIG_PATH: openClawConfigPath,
          OPENCLAW_STATE_DIR: openClawStateDir,
        },
      })

      await connector.install('OpenClaw')
      await writeFile(
        agentFile,
        'before\n\n<!-- BEGIN BYTEROVER RULES -->\nstale block\n<!-- END BYTEROVER RULES -->\n\nafter\n',
        'utf8',
      )

      const reinstallResult = await connector.install('OpenClaw')
      expect(reinstallResult.success).to.be.true
      expect(reinstallResult.alreadyInstalled).to.be.true
      const refreshedContent = await readFile(agentFile, 'utf8')
      expect(refreshedContent).to.include('before')
      expect(refreshedContent).to.include('after')
      expect(refreshedContent).to.include('brv swarm query')
      expect(refreshedContent).not.to.include('stale block')

      const uninstallResult = await connector.uninstall('OpenClaw')
      expect(uninstallResult.success).to.be.true
      expect(uninstallResult.configPath).to.equal(path.join(openClawStateDir, 'skills', BRV_SKILL_NAME))
      const uninstalledContent = await readFile(agentFile, 'utf8')
      expect(uninstalledContent).to.include('before')
      expect(uninstalledContent).to.include('after')
      expect(uninstalledContent).not.to.include('<!-- BEGIN BYTEROVER RULES -->')
      expect(await fileService.exists(path.join(openClawStateDir, 'skills', BRV_SKILL_NAME, 'SKILL.md'))).to.be.false
    })

    it('should install Hermes skill files under HERMES_HOME and patch SOUL.md', async () => {
      const hermesHome = path.join(testDir, 'hermes-home')
      const connector = createConnector({
        env: {
          ...process.env,
          HERMES_HOME: hermesHome,
        },
      })

      const result = await connector.install('Hermes')

      expect(result.success).to.be.true
      const skillContent = await readFile(path.join(hermesHome, 'skills', BRV_SKILL_NAME, 'SKILL.md'), 'utf8')
      expect(skillContent).to.include('name: byterover')
      const soulContent = await readFile(path.join(hermesHome, 'SOUL.md'), 'utf8')
      expect(soulContent).to.include('<!-- BEGIN BYTEROVER RULES -->')
      expect(soulContent).to.include('brv query')
      expect(soulContent).to.include('brv swarm query')
      expect(await fileService.exists(path.join(hermesHome, 'hermes-agent', 'AGENTS.md'))).to.be.false
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

    it('should report not installed when a managed skill reference file is missing', async () => {
      const agent = 'Claude Code' as const
      const {projectPath} = SKILL_CONNECTOR_CONFIGS[agent]
      await skillConnector.install(agent)
      await rm(path.join(testDir, projectPath, BRV_SKILL_NAME, 'query.md'))

      const result = await skillConnector.status(agent)

      expect(result.installed).to.be.false
      expect(result.configExists).to.be.false
    })

    it('should return error status for unsupported agent', async () => {
      const result = await skillConnector.status('Augment Code')

      expect(result.installed).to.be.false
      expect(result.configExists).to.be.false
      expect(result.error).to.be.a('string')
      expect(result.error).to.include('does not support agent')
    })

    it('should return installed true for Hermes when SKILL.md and SOUL.md block both exist', async () => {
      const hermesHome = path.join(testDir, 'hermes-home')
      const connector = createConnector({env: {...process.env, HERMES_HOME: hermesHome}})
      await connector.install('Hermes')

      const result = await connector.status('Hermes')

      expect(result.installed).to.be.true
      expect(result.configExists).to.be.true
      expect(result.configPath).to.equal(path.join(hermesHome, 'skills', BRV_SKILL_NAME))
    })

    it('should report Hermes not installed when SKILL.md exists but SOUL.md block is missing', async () => {
      const hermesHome = path.join(testDir, 'hermes-home')
      const connector = createConnector({env: {...process.env, HERMES_HOME: hermesHome}})
      await connector.install('Hermes')
      // Simulate an upgrade / user edit that drops the managed block but keeps SKILL.md.
      await writeFile(path.join(hermesHome, 'SOUL.md'), 'just my own soul instructions\n', 'utf8')

      const result = await connector.status('Hermes')

      expect(result.installed).to.be.false
    })

    it('should let a same-target re-install repair a missing Hermes SOUL.md block', async () => {
      const hermesHome = path.join(testDir, 'hermes-home')
      const connector = createConnector({env: {...process.env, HERMES_HOME: hermesHome}})
      await connector.install('Hermes')
      await writeFile(path.join(hermesHome, 'SOUL.md'), 'just my own soul instructions\n', 'utf8')

      await connector.install('Hermes')

      const soulContent = await readFile(path.join(hermesHome, 'SOUL.md'), 'utf8')
      expect(soulContent).to.include('<!-- BEGIN BYTEROVER RULES -->')
      const result = await connector.status('Hermes')
      expect(result.installed).to.be.true
    })

    it('should report OpenClaw not installed when SKILL.md exists but the agent block is missing', async () => {
      const openClawStateDir = path.join(testDir, 'openclaw-state')
      const openClawConfigPath = path.join(openClawStateDir, 'openclaw.json')
      await mkdir(openClawStateDir, {recursive: true})
      await writeFile(openClawConfigPath, JSON.stringify({agents: {defaults: {}}}, null, 2), 'utf8')
      const connector = createConnector({
        env: {
          ...process.env,
          OPENCLAW_CONFIG_PATH: openClawConfigPath,
          OPENCLAW_STATE_DIR: openClawStateDir,
        },
      })
      await connector.install('OpenClaw')
      // No workspace configured → default agent uses ~/.openclaw/workspace (home-based).
      const agentFile = path.join(testDir, '.openclaw', 'workspace', 'AGENTS.md')
      await writeFile(agentFile, 'plain agent instructions\n', 'utf8')

      const result = await connector.status('OpenClaw')

      expect(result.installed).to.be.false
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
      const result = await skillConnector.writeSkillFiles({agent: 'Claude Code', files, skillName: 'my-hub-skill'})

      expect(result.alreadyInstalled).to.be.false
      expect(result.installedPath).to.equal(path.join(testDir, '.claude/skills/my-hub-skill'))
      expect(result.installedFiles).to.have.lengthOf(2)

      const skillContent = await readFile(path.join(testDir, '.claude/skills/my-hub-skill/SKILL.md'), 'utf8')
      expect(skillContent).to.equal('# My Skill')

      const readmeContent = await readFile(path.join(testDir, '.claude/skills/my-hub-skill/README.md'), 'utf8')
      expect(readmeContent).to.equal('# Readme')
    })

    it('should return alreadyInstalled if all files exist', async () => {
      const files = [{content: '# Skill', name: 'SKILL.md'}]

      // First write
      await skillConnector.writeSkillFiles({agent: 'Claude Code', files, skillName: 'existing-skill'})

      // Second write
      const result = await skillConnector.writeSkillFiles({agent: 'Claude Code', files, skillName: 'existing-skill'})

      expect(result.alreadyInstalled).to.be.true
      expect(result.installedFiles).to.have.lengthOf(0)
    })

    it('should repair missing files when a hub skill is partially installed', async () => {
      const firstWrite = [{content: '# Skill', name: 'SKILL.md'}]
      const fullWrite = [
        {content: '# Skill', name: 'SKILL.md'},
        {content: '# Query', name: 'query.md'},
      ]
      await skillConnector.writeSkillFiles({agent: 'Claude Code', files: firstWrite, skillName: 'partial-skill'})

      const result = await skillConnector.writeSkillFiles({agent: 'Claude Code', files: fullWrite, skillName: 'partial-skill'})

      expect(result.alreadyInstalled).to.be.false
      expect(result.installedFiles).to.have.lengthOf(1)
      expect(result.installedFiles[0]).to.equal(path.join(testDir, '.claude/skills/partial-skill/query.md'))

      const queryContent = await readFile(path.join(testDir, '.claude/skills/partial-skill/query.md'), 'utf8')
      expect(queryContent).to.equal('# Query')
    })

    it('should throw for unsupported agent', async () => {
      const files = [{content: '# Skill', name: 'SKILL.md'}]

      try {
        await skillConnector.writeSkillFiles({agent: 'Augment Code', files, skillName: 'my-skill'})
        expect.fail('Should have thrown')
      } catch (error) {
        expect((error as Error).message).to.include('does not support agent')
      }
    })

    it('should write to correct directory for Cursor', async () => {
      const files = [{content: '# Cursor Skill', name: 'SKILL.md'}]
      const result = await skillConnector.writeSkillFiles({agent: 'Cursor', files, skillName: 'cursor-skill'})

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

  function createConnector(options?: {env?: NodeJS.ProcessEnv}): SkillConnector {
    return new SkillConnector({
      env: options?.env,
      fileService,
      homeDir: testDir,
      projectRoot: testDir,
    })
  }
})

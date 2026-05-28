import {expect} from 'chai'
import {dump as yamlDump, load as yamlLoad} from 'js-yaml'
import {mkdir, rm, writeFile} from 'node:fs/promises'
import {homedir, tmpdir} from 'node:os'
import path from 'node:path'

import type {IFileService} from '../../../../../src/server/core/interfaces/services/i-file-service.js'
import type {IRuleTemplateService} from '../../../../../src/server/core/interfaces/services/i-rule-template-service.js'
import type {
  JsonMcpConnectorConfig,
  McpSupportedAgent,
} from '../../../../../src/server/infra/connectors/mcp/mcp-connector-config.js'

import {getClaudeDesktopConfigPath} from '../../../../../src/server/infra/connectors/mcp/claude-desktop-config-path.js'
import {MCP_CONNECTOR_CONFIGS} from '../../../../../src/server/infra/connectors/mcp/mcp-connector-config.js'
import {McpConnector} from '../../../../../src/server/infra/connectors/mcp/mcp-connector.js'
import {BRV_RULE_MARKERS} from '../../../../../src/server/infra/connectors/shared/constants.js'
import {FsFileService} from '../../../../../src/server/infra/file/fs-file-service.js'

/**
 * Mock template service for testing.
 * Includes brv-query and brv-curate tool references to simulate MCP content.
 */
const createMockTemplateService = (): IRuleTemplateService => ({
  generateRuleContent: async () =>
    `${BRV_RULE_MARKERS.START}\nMock MCP rule content\nUse brv-query to query context\nUse brv-curate to store context\n${BRV_RULE_MARKERS.END}`,
})

describe('McpConnector', () => {
  let testDir: string
  let fileService: FsFileService
  let mcpConnector: McpConnector
  let templateService: IRuleTemplateService

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `brv-mcp-test-${Date.now()}`)
    await mkdir(testDir, {recursive: true})
    fileService = new FsFileService()
    templateService = createMockTemplateService()
    mcpConnector = new McpConnector({
      fileService,
      projectRoot: testDir,
      templateService,
    })
  })

  afterEach(async () => {
    await rm(testDir, {force: true, recursive: true})
  })

  describe('connectorType', () => {
    it('should have connectorType "mcp"', () => {
      expect(mcpConnector.connectorType).to.equal('mcp')
    })
  })

  describe('getSupportedAgents', () => {
    it('should return all agents with MCP configs', () => {
      const agents = mcpConnector.getSupportedAgents()
      expect(agents).to.include('Claude Code')
      expect(agents).to.include('Cursor')
      expect(agents).to.include('Windsurf')
      expect(agents).to.include('Cline')
      expect(agents).to.include('Antigravity')
      expect(agents).to.include('Claude Desktop')
      expect(agents.length).to.be.greaterThan(3)
    })
  })

  describe('isSupported', () => {
    it('should return true for Claude Code', () => {
      expect(mcpConnector.isSupported('Claude Code')).to.be.true
    })

    it('should return true for Cursor', () => {
      expect(mcpConnector.isSupported('Cursor')).to.be.true
    })

    it('should return true for Windsurf', () => {
      expect(mcpConnector.isSupported('Windsurf')).to.be.true
    })

    it('should return true for Cline', () => {
      expect(mcpConnector.isSupported('Cline')).to.be.true
    })

    it('should return true for Antigravity', () => {
      expect(mcpConnector.isSupported('Antigravity')).to.be.true
    })

    it('should return true for Roo Code', () => {
      expect(mcpConnector.isSupported('Roo Code')).to.be.true
    })

    it('should return true for Amp', () => {
      expect(mcpConnector.isSupported('Amp')).to.be.true
    })

    it('should return true for Codex', () => {
      expect(mcpConnector.isSupported('Codex')).to.be.true
    })

    it('should return true for Claude Desktop', () => {
      expect(mcpConnector.isSupported('Claude Desktop')).to.be.true
    })
  })

  describe('getConfigPath', () => {
    it('should return config path for Claude Code', () => {
      expect(mcpConnector.getConfigPath('Claude Code')).to.equal(path.join(testDir, '.mcp.json'))
    })

    it('should return config path for Cursor', () => {
      expect(mcpConnector.getConfigPath('Cursor')).to.equal(path.join(testDir, '.cursor/mcp.json'))
    })

    it('should return config path for Windsurf (global scope)', () => {
      expect(mcpConnector.getConfigPath('Windsurf')).to.equal(path.join(homedir(), '.codeium/windsurf/mcp_config.json'))
    })

    it('should return config path for Antigravity (global scope)', () => {
      expect(mcpConnector.getConfigPath('Antigravity')).to.equal(
        path.join(homedir(), '.gemini/antigravity/mcp_config.json'),
      )
    })

    it('should return config path for Codex (TOML format)', () => {
      expect(mcpConnector.getConfigPath('Codex')).to.equal(path.join(homedir(), '.codex/config.toml'))
    })

    it('should return platform-specific config path for Claude Desktop', () => {
      const configPath = mcpConnector.getConfigPath('Claude Desktop')
      expect(configPath).to.equal(getClaudeDesktopConfigPath())
    })
  })

  // Test each supported agent with project-level config (has configPath and mode: 'auto')
  const testAgents: Array<{agent: McpSupportedAgent; configDir: string}> = [
    {agent: 'Claude Code', configDir: '.'},
    {agent: 'Cursor', configDir: '.cursor'},
    {agent: 'Roo Code', configDir: '.roo'},
  ]

  for (const {agent, configDir} of testAgents) {
    describe(`${agent}`, () => {
      const {configPath, serverConfig} = MCP_CONNECTOR_CONFIGS[agent] as JsonMcpConnectorConfig

      describe('install', () => {
        it('should create new config file if not exists', async () => {
          const result = await mcpConnector.install(agent)

          expect(result.success).to.be.true
          expect(result.alreadyInstalled).to.be.false
          expect(result.configPath).to.equal(path.join(testDir, configPath!))

          const content = await fileService.read(path.join(testDir, configPath!))
          const json = JSON.parse(content)
          expect(json.mcpServers.brv).to.deep.equal(serverConfig)
        })

        it('should add MCP server to existing config without other servers', async () => {
          const existingConfig = {someOtherSetting: true}
          await mkdir(path.join(testDir, configDir), {recursive: true})
          await writeFile(path.join(testDir, configPath!), JSON.stringify(existingConfig))

          const result = await mcpConnector.install(agent)

          expect(result.success).to.be.true
          expect(result.alreadyInstalled).to.be.false

          const content = await fileService.read(path.join(testDir, configPath!))
          const json = JSON.parse(content)
          expect(json.someOtherSetting).to.be.true // preserved
          expect(json.mcpServers.brv).to.deep.equal(serverConfig)
        })

        it('should preserve other MCP servers when installing', async () => {
          const existingConfig = {
            mcpServers: {
              'other-server': {
                command: 'other-cmd',
                args: ['arg1'], // eslint-disable-line perfectionist/sort-objects
              },
            },
          }
          await mkdir(path.join(testDir, configDir), {recursive: true})
          await writeFile(path.join(testDir, configPath!), JSON.stringify(existingConfig))

          const result = await mcpConnector.install(agent)

          expect(result.success).to.be.true
          expect(result.alreadyInstalled).to.be.false

          const content = await fileService.read(path.join(testDir, configPath!))
          const json = JSON.parse(content)
          expect(json.mcpServers['other-server']).to.deep.equal({
            command: 'other-cmd',
            args: ['arg1'], // eslint-disable-line perfectionist/sort-objects
          })
          expect(json.mcpServers.brv).to.deep.equal(serverConfig)
        })

        it('should return alreadyInstalled if server exists', async () => {
          const existingConfig = {
            mcpServers: {
              brv: serverConfig,
            },
          }
          await mkdir(path.join(testDir, configDir), {recursive: true})
          await writeFile(path.join(testDir, configPath!), JSON.stringify(existingConfig))

          const result = await mcpConnector.install(agent)

          expect(result.success).to.be.true
          expect(result.alreadyInstalled).to.be.true
        })
      })

      describe('uninstall', () => {
        it('should return wasInstalled false if config not exists', async () => {
          const result = await mcpConnector.uninstall(agent)

          expect(result.success).to.be.true
          expect(result.wasInstalled).to.be.false
        })

        it('should remove only our server and preserve others', async () => {
          const existingConfig = {
            mcpServers: {
              brv: serverConfig,
              'other-server': {
                command: 'other-cmd',
                args: [], // eslint-disable-line perfectionist/sort-objects
              },
            },
            otherSetting: 'preserved',
          }
          await mkdir(path.join(testDir, configDir), {recursive: true})
          await writeFile(path.join(testDir, configPath!), JSON.stringify(existingConfig))

          const result = await mcpConnector.uninstall(agent)

          expect(result.success).to.be.true
          expect(result.wasInstalled).to.be.true

          const content = await fileService.read(path.join(testDir, configPath!))
          const json = JSON.parse(content)
          expect(json.mcpServers.brv).to.be.undefined
          expect(json.mcpServers['other-server']).to.deep.equal({
            command: 'other-cmd',
            args: [], // eslint-disable-line perfectionist/sort-objects
          })
          expect(json.otherSetting).to.equal('preserved')
        })

        it('should return wasInstalled false if server not present', async () => {
          const existingConfig = {
            mcpServers: {
              'other-server': {
                command: 'other-cmd',
                args: [], // eslint-disable-line perfectionist/sort-objects
              },
            },
          }
          await mkdir(path.join(testDir, configDir), {recursive: true})
          await writeFile(path.join(testDir, configPath!), JSON.stringify(existingConfig))

          const result = await mcpConnector.uninstall(agent)

          expect(result.success).to.be.true
          expect(result.wasInstalled).to.be.false
        })
      })

      describe('status', () => {
        it('should return configExists false if file not exists', async () => {
          const result = await mcpConnector.status(agent)

          expect(result.configExists).to.be.false
          expect(result.installed).to.be.false
          expect(result.error).to.be.undefined
        })

        it('should return installed true if server exists', async () => {
          const existingConfig = {
            mcpServers: {
              brv: serverConfig,
            },
          }
          await mkdir(path.join(testDir, configDir), {recursive: true})
          await writeFile(path.join(testDir, configPath!), JSON.stringify(existingConfig))

          const result = await mcpConnector.status(agent)

          expect(result.configExists).to.be.true
          expect(result.installed).to.be.true
          expect(result.error).to.be.undefined
        })

        it('should return installed false if server not present', async () => {
          const existingConfig = {mcpServers: {}}
          await mkdir(path.join(testDir, configDir), {recursive: true})
          await writeFile(path.join(testDir, configPath!), JSON.stringify(existingConfig))

          const result = await mcpConnector.status(agent)

          expect(result.configExists).to.be.true
          expect(result.installed).to.be.false
          expect(result.error).to.be.undefined
        })
      })
    })
  }

  describe('Claude Desktop (configPathResolver)', () => {
    const {serverConfig} = MCP_CONNECTOR_CONFIGS['Claude Desktop']
    let files: Map<string, string>
    let desktopConnector: McpConnector
    let configPath: string

    beforeEach(() => {
      configPath = getClaudeDesktopConfigPath()
      files = new Map()
      const stubFileService: IFileService = {
        async createBackup() {
          return ''
        },
        async delete(p) {
          files.delete(p)
        },
        async deleteDirectory() {},
        async exists(p) {
          return files.has(p)
        },
        async read(p) {
          const c = files.get(p)
          if (c === undefined) throw new Error('ENOENT')
          return c
        },
        async replaceContent() {},
        async write(content, p) {
          files.set(p, content)
        },
      }
      desktopConnector = new McpConnector({
        fileService: stubFileService,
        projectRoot: testDir,
        templateService,
      })
    })

    describe('install', () => {
      it('should create new config file if not exists', async () => {
        const result = await desktopConnector.install('Claude Desktop')

        expect(result.success).to.be.true
        expect(result.alreadyInstalled).to.be.false
        expect(result.configPath).to.equal(configPath)

        const json = JSON.parse(files.get(configPath)!)
        expect(json.mcpServers.brv).to.deep.equal(serverConfig)
      })

      it('should add MCP server to existing config', async () => {
        files.set(configPath, JSON.stringify({someOtherSetting: true}))

        const result = await desktopConnector.install('Claude Desktop')

        expect(result.success).to.be.true
        expect(result.alreadyInstalled).to.be.false

        const json = JSON.parse(files.get(configPath)!)
        expect(json.someOtherSetting).to.be.true
        expect(json.mcpServers.brv).to.deep.equal(serverConfig)
      })

      it('should return alreadyInstalled if server exists', async () => {
        files.set(configPath, JSON.stringify({mcpServers: {brv: serverConfig}}))

        const result = await desktopConnector.install('Claude Desktop')

        expect(result.success).to.be.true
        expect(result.alreadyInstalled).to.be.true
      })
    })

    describe('status', () => {
      it('should return configExists false if file not exists', async () => {
        const result = await desktopConnector.status('Claude Desktop')

        expect(result.configExists).to.be.false
        expect(result.installed).to.be.false
      })

      it('should return installed true if server exists', async () => {
        files.set(configPath, JSON.stringify({mcpServers: {brv: serverConfig}}))

        const result = await desktopConnector.status('Claude Desktop')

        expect(result.configExists).to.be.true
        expect(result.installed).to.be.true
      })
    })

    describe('uninstall', () => {
      it('should return wasInstalled false if config not exists', async () => {
        const result = await desktopConnector.uninstall('Claude Desktop')

        expect(result.success).to.be.true
        expect(result.wasInstalled).to.be.false
      })

      it('should remove only our server and preserve others', async () => {
        const existingConfig = {
          mcpServers: {
            brv: serverConfig,
            'other-server': {
              command: 'other-cmd',
              args: [], // eslint-disable-line perfectionist/sort-objects
            },
          },
          otherSetting: 'preserved',
        }
        files.set(configPath, JSON.stringify(existingConfig))

        const result = await desktopConnector.uninstall('Claude Desktop')

        expect(result.success).to.be.true
        expect(result.wasInstalled).to.be.true

        const json = JSON.parse(files.get(configPath)!)
        expect(json.mcpServers.brv).to.be.undefined
        expect(json.mcpServers['other-server']).to.deep.equal({
          command: 'other-cmd',
          args: [], // eslint-disable-line perfectionist/sort-objects
        })
        expect(json.otherSetting).to.equal('preserved')
      })
    })
  })

  describe('Hermes (YAML, global scope)', () => {
    const {serverConfig} = MCP_CONNECTOR_CONFIGS.Hermes
    let files: Map<string, string>
    let hermesConnector: McpConnector
    let configPath: string

    beforeEach(() => {
      configPath = path.join(homedir(), '.hermes/config.yaml')
      files = new Map()
      const stubFileService: IFileService = {
        async createBackup() {
          return ''
        },
        async delete(p) {
          files.delete(p)
        },
        async deleteDirectory() {},
        async exists(p) {
          return files.has(p)
        },
        async read(p) {
          const c = files.get(p)
          if (c === undefined) throw new Error('ENOENT')
          return c
        },
        async replaceContent() {},
        async write(content, p) {
          files.set(p, content)
        },
      }
      hermesConnector = new McpConnector({
        fileService: stubFileService,
        projectRoot: testDir,
        templateService,
      })
    })

    it('reports Hermes as supported', () => {
      expect(hermesConnector.isSupported('Hermes')).to.be.true
      expect(hermesConnector.getConfigPath('Hermes')).to.equal(configPath)
    })

    it('resolves the Hermes config path under HERMES_HOME when set', () => {
      const previous = process.env.HERMES_HOME
      const customHome = path.join(testDir, 'relocated-hermes')
      process.env.HERMES_HOME = customHome
      try {
        expect(hermesConnector.getConfigPath('Hermes')).to.equal(path.join(customHome, 'config.yaml'))
      } finally {
        if (previous === undefined) delete process.env.HERMES_HOME
        else process.env.HERMES_HOME = previous
      }
    })

    describe('install', () => {
      it('creates ~/.hermes/config.yaml with mcp_servers.brv when file is missing', async () => {
        const result = await hermesConnector.install('Hermes')

        expect(result.success).to.be.true
        expect(result.alreadyInstalled).to.be.false
        expect(result.configPath).to.equal(configPath)

        const parsed = yamlLoad(files.get(configPath)!) as Record<string, Record<string, unknown>>
        expect(parsed.mcp_servers.brv).to.deep.equal(serverConfig)
      })

      it('preserves unrelated Hermes config (model, other servers) when adding brv', async () => {
        files.set(
          configPath,
          // eslint-disable-next-line camelcase
          yamlDump({mcp_servers: {other: {command: 'other'}}, model: 'sonnet'}),
        )

        const result = await hermesConnector.install('Hermes')

        expect(result.success).to.be.true
        expect(result.alreadyInstalled).to.be.false

        const parsed = yamlLoad(files.get(configPath)!) as Record<string, unknown>
        const servers = parsed.mcp_servers as Record<string, unknown>
        expect(parsed.model).to.equal('sonnet')
        expect(servers.other).to.deep.equal({command: 'other'})
        expect(servers.brv).to.deep.equal(serverConfig)
      })

      it('returns alreadyInstalled when brv server already present', async () => {
        // eslint-disable-next-line camelcase
        files.set(configPath, yamlDump({mcp_servers: {brv: serverConfig}}))

        const result = await hermesConnector.install('Hermes')

        expect(result.success).to.be.true
        expect(result.alreadyInstalled).to.be.true
      })
    })

    describe('status', () => {
      it('returns configExists=false when file missing', async () => {
        const result = await hermesConnector.status('Hermes')

        expect(result.configExists).to.be.false
        expect(result.installed).to.be.false
      })

      it('returns installed=true when brv server present', async () => {
        // eslint-disable-next-line camelcase
        files.set(configPath, yamlDump({mcp_servers: {brv: serverConfig}}))

        const result = await hermesConnector.status('Hermes')

        expect(result.configExists).to.be.true
        expect(result.installed).to.be.true
      })

      it('returns installed=false when only other servers present', async () => {
        // eslint-disable-next-line camelcase
        files.set(configPath, yamlDump({mcp_servers: {other: {command: 'other'}}}))

        const result = await hermesConnector.status('Hermes')

        expect(result.configExists).to.be.true
        expect(result.installed).to.be.false
      })
    })

    describe('uninstall', () => {
      it('returns wasInstalled=false when config does not exist', async () => {
        const result = await hermesConnector.uninstall('Hermes')

        expect(result.success).to.be.true
        expect(result.wasInstalled).to.be.false
      })

      it('removes only brv entry, preserving other servers and root keys', async () => {
        files.set(
          configPath,
          yamlDump({
            // eslint-disable-next-line camelcase
            mcp_servers: {
              brv: serverConfig,
              other: {command: 'other'},
            },
            model: 'sonnet',
          }),
        )

        const result = await hermesConnector.uninstall('Hermes')

        expect(result.success).to.be.true
        expect(result.wasInstalled).to.be.true

        const parsed = yamlLoad(files.get(configPath)!) as Record<string, unknown>
        const servers = parsed.mcp_servers as Record<string, unknown>
        expect(servers.brv).to.be.undefined
        expect(servers.other).to.deep.equal({command: 'other'})
        expect(parsed.model).to.equal('sonnet')
      })
    })
  })

  describe('unsupported agent', () => {
    it('should return failure for unsupported agent on install', async () => {
      // Cast to bypass type checking for testing unsupported agent behavior
      const result = await mcpConnector.install('NonExistentAgent' as never)

      expect(result.success).to.be.false
      expect(result.message).to.include('does not support agent')
    })

    it('should return failure for unsupported agent on uninstall', async () => {
      const result = await mcpConnector.uninstall('NonExistentAgent' as never)

      expect(result.success).to.be.false
      expect(result.message).to.include('does not support agent')
    })

    it('should return error status for unsupported agent', async () => {
      const result = await mcpConnector.status('NonExistentAgent' as never)

      expect(result.configExists).to.be.false
      expect(result.installed).to.be.false
      expect(result.error).to.include('does not support agent')
    })
  })

  describe('edge cases', () => {
    it('should handle malformed JSON gracefully on install by starting fresh', async () => {
      await mkdir(path.join(testDir, '.cursor'), {recursive: true})
      await writeFile(path.join(testDir, '.cursor/mcp.json'), 'not valid json')

      const result = await mcpConnector.install('Cursor')

      expect(result.success).to.be.true
      expect(result.alreadyInstalled).to.be.false

      const content = await fileService.read(path.join(testDir, '.cursor/mcp.json'))
      const json = JSON.parse(content)
      expect(json.mcpServers.brv).to.deep.equal(MCP_CONNECTOR_CONFIGS.Cursor.serverConfig)
    })

    it('should handle malformed JSON gracefully on status', async () => {
      await mkdir(path.join(testDir, '.cursor'), {recursive: true})
      await writeFile(path.join(testDir, '.cursor/mcp.json'), 'not valid json')

      const result = await mcpConnector.status('Cursor')

      // Malformed JSON is treated as file exists but server not found
      expect(result.configExists).to.be.true
      expect(result.installed).to.be.false
    })

    it('should handle empty file gracefully on install', async () => {
      await mkdir(path.join(testDir, '.cursor'), {recursive: true})
      await writeFile(path.join(testDir, '.cursor/mcp.json'), '')

      const result = await mcpConnector.install('Cursor')

      expect(result.success).to.be.true
      expect(result.alreadyInstalled).to.be.false

      const content = await fileService.read(path.join(testDir, '.cursor/mcp.json'))
      const json = JSON.parse(content)
      expect(json.mcpServers.brv).to.deep.equal(MCP_CONNECTOR_CONFIGS.Cursor.serverConfig)
    })

    it('should handle empty mcpServers object', async () => {
      const existingConfig = {mcpServers: {}}
      await mkdir(path.join(testDir, '.cursor'), {recursive: true})
      await writeFile(path.join(testDir, '.cursor/mcp.json'), JSON.stringify(existingConfig))

      const result = await mcpConnector.install('Cursor')

      expect(result.success).to.be.true
      expect(result.alreadyInstalled).to.be.false

      const content = await fileService.read(path.join(testDir, '.cursor/mcp.json'))
      const json = JSON.parse(content)
      expect(json.mcpServers.brv).to.deep.equal(MCP_CONNECTOR_CONFIGS.Cursor.serverConfig)
    })

    it('should handle config with nested structure but no mcpServers', async () => {
      const existingConfig = {
        settings: {
          theme: 'dark',
        },
      }
      await mkdir(path.join(testDir, '.cursor'), {recursive: true})
      await writeFile(path.join(testDir, '.cursor/mcp.json'), JSON.stringify(existingConfig))

      const result = await mcpConnector.install('Cursor')

      expect(result.success).to.be.true

      const content = await fileService.read(path.join(testDir, '.cursor/mcp.json'))
      const json = JSON.parse(content)
      expect(json.settings.theme).to.equal('dark') // preserved
      expect(json.mcpServers.brv).to.deep.equal(MCP_CONNECTOR_CONFIGS.Cursor.serverConfig)
    })
  })

  describe('manual mode agents', () => {
    const manualAgents: McpSupportedAgent[] = ['Cline', 'Augment Code', 'Qoder', 'Trae.ai', 'Warp']

    for (const agent of manualAgents) {
      it(`should return manual setup instructions for ${agent}`, async () => {
        const result = await mcpConnector.install(agent)
        expect(result.success).to.be.true
        expect(result.requiresManualSetup).to.be.true
        expect(result.message).to.include('Manual setup required')
      })
    }
  })
})

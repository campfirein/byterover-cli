import {expect} from 'chai'
import {dump as yamlDump, load as yamlLoad} from 'js-yaml'
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'

import {YamlMcpConfigWriter} from '../../../../../src/server/infra/connectors/mcp/yaml-mcp-config-writer.js'
import {FsFileService} from '../../../../../src/server/infra/file/fs-file-service.js'

/* eslint-disable camelcase */

describe('YamlMcpConfigWriter', () => {
  let testDir: string
  let fileService: FsFileService

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `brv-yaml-writer-test-${Date.now()}`)
    await mkdir(testDir, {recursive: true})
    fileService = new FsFileService()
  })

  afterEach(async () => {
    await rm(testDir, {force: true, recursive: true})
  })

  describe('exists', () => {
    it('returns fileExists=false when file does not exist', async () => {
      const writer = new YamlMcpConfigWriter({
        fileService,
        serverKeyPath: ['mcp_servers', 'brv'],
      })
      const filePath = path.join(testDir, 'config.yaml')

      const result = await writer.exists(filePath)

      expect(result.fileExists).to.be.false
      expect(result.serverExists).to.be.false
    })

    it('returns serverExists=false when file exists but server entry does not', async () => {
      const writer = new YamlMcpConfigWriter({
        fileService,
        serverKeyPath: ['mcp_servers', 'brv'],
      })
      const filePath = path.join(testDir, 'config.yaml')
      await writeFile(filePath, yamlDump({mcp_servers: {}}))

      const result = await writer.exists(filePath)

      expect(result.fileExists).to.be.true
      expect(result.serverExists).to.be.false
    })

    it('returns serverExists=true when server entry exists', async () => {
      const writer = new YamlMcpConfigWriter({
        fileService,
        serverKeyPath: ['mcp_servers', 'brv'],
      })
      const filePath = path.join(testDir, 'config.yaml')
      await writeFile(filePath, yamlDump({mcp_servers: {brv: {command: 'brv'}}}))

      const result = await writer.exists(filePath)

      expect(result.fileExists).to.be.true
      expect(result.serverExists).to.be.true
    })

    it('handles nested key paths', async () => {
      const writer = new YamlMcpConfigWriter({
        fileService,
        serverKeyPath: ['outer', 'inner', 'brv'],
      })
      const filePath = path.join(testDir, 'config.yaml')
      await writeFile(filePath, yamlDump({outer: {inner: {brv: {command: 'brv'}}}}))

      const result = await writer.exists(filePath)

      expect(result.fileExists).to.be.true
      expect(result.serverExists).to.be.true
    })

    it('returns serverExists=false for malformed YAML', async () => {
      const writer = new YamlMcpConfigWriter({
        fileService,
        serverKeyPath: ['mcp_servers', 'brv'],
      })
      const filePath = path.join(testDir, 'config.yaml')
      await writeFile(filePath, ':\n\tnot valid yaml: [')

      const result = await writer.exists(filePath)

      expect(result.fileExists).to.be.true
      expect(result.serverExists).to.be.false
    })

    it('returns serverExists=false when YAML root is not an object', async () => {
      const writer = new YamlMcpConfigWriter({
        fileService,
        serverKeyPath: ['mcp_servers', 'brv'],
      })
      const filePath = path.join(testDir, 'config.yaml')
      await writeFile(filePath, '- a\n- b\n')

      const result = await writer.exists(filePath)

      expect(result.fileExists).to.be.true
      expect(result.serverExists).to.be.false
    })
  })

  describe('write', () => {
    it('creates new file with server config', async () => {
      const writer = new YamlMcpConfigWriter({
        fileService,
        serverKeyPath: ['mcp_servers', 'brv'],
      })
      const filePath = path.join(testDir, 'config.yaml')
      const serverConfig = {command: 'brv', args: ['mcp']} // eslint-disable-line perfectionist/sort-objects

      await writer.write(filePath, serverConfig)

      const parsed = yamlLoad(await readFile(filePath, 'utf8')) as Record<string, Record<string, unknown>>
      expect(parsed.mcp_servers.brv).to.deep.equal(serverConfig)
    })

    it('adds server to existing config preserving other settings', async () => {
      const writer = new YamlMcpConfigWriter({
        fileService,
        serverKeyPath: ['mcp_servers', 'brv'],
      })
      const filePath = path.join(testDir, 'config.yaml')
      await writeFile(
        filePath,
        yamlDump({mcp_servers: {other: {command: 'other'}}, model: 'sonnet'}),
      )
      const serverConfig = {command: 'brv', args: ['mcp']} // eslint-disable-line perfectionist/sort-objects

      await writer.write(filePath, serverConfig)

      const parsed = yamlLoad(await readFile(filePath, 'utf8')) as Record<string, unknown>
      const servers = parsed.mcp_servers as Record<string, unknown>
      expect(parsed.model).to.equal('sonnet')
      expect(servers.other).to.deep.equal({command: 'other'})
      expect(servers.brv).to.deep.equal(serverConfig)
    })

    it('overwrites existing server config', async () => {
      const writer = new YamlMcpConfigWriter({
        fileService,
        serverKeyPath: ['mcp_servers', 'brv'],
      })
      const filePath = path.join(testDir, 'config.yaml')
      await writeFile(filePath, yamlDump({mcp_servers: {brv: {command: 'old'}}}))
      const serverConfig = {command: 'brv', args: ['mcp']} // eslint-disable-line perfectionist/sort-objects

      await writer.write(filePath, serverConfig)

      const parsed = yamlLoad(await readFile(filePath, 'utf8')) as Record<string, Record<string, unknown>>
      expect(parsed.mcp_servers.brv).to.deep.equal(serverConfig)
    })

    it('creates intermediate objects in key path', async () => {
      const writer = new YamlMcpConfigWriter({
        fileService,
        serverKeyPath: ['level1', 'level2', 'brv'],
      })
      const filePath = path.join(testDir, 'config.yaml')
      const serverConfig = {command: 'brv'}

      await writer.write(filePath, serverConfig)

      const parsed = yamlLoad(await readFile(filePath, 'utf8')) as Record<string, Record<string, Record<string, unknown>>>
      expect(parsed.level1.level2.brv).to.deep.equal(serverConfig)
    })

    it('throws and preserves existing content when YAML is malformed', async () => {
      const writer = new YamlMcpConfigWriter({
        fileService,
        serverKeyPath: ['mcp_servers', 'brv'],
      })
      const filePath = path.join(testDir, 'config.yaml')
      const originalContent = ':\n\t[bad: yaml'
      await writeFile(filePath, originalContent)
      const serverConfig = {command: 'brv'}

      let error: unknown
      try {
        await writer.write(filePath, serverConfig)
      } catch (error_) {
        error = error_
      }

      expect(error).to.be.instanceOf(Error)
      if (!(error instanceof Error)) throw new Error('Expected write to throw')

      expect(error.message).to.include('Cannot update YAML MCP config')
      expect(await readFile(filePath, 'utf8')).to.equal(originalContent)
    })

    it('throws and preserves existing content when YAML root is not a mapping', async () => {
      const writer = new YamlMcpConfigWriter({
        fileService,
        serverKeyPath: ['mcp_servers', 'brv'],
      })
      const filePath = path.join(testDir, 'config.yaml')
      const originalContent = '- a\n- b\n'
      await writeFile(filePath, originalContent)
      const serverConfig = {command: 'brv'}

      let error: unknown
      try {
        await writer.write(filePath, serverConfig)
      } catch (error_) {
        error = error_
      }

      expect(error).to.be.instanceOf(Error)
      if (!(error instanceof Error)) throw new Error('Expected write to throw')

      expect(error.message).to.include('Cannot update YAML MCP config')
      expect(await readFile(filePath, 'utf8')).to.equal(originalContent)
    })
  })

  describe('remove', () => {
    it('returns false when file does not exist', async () => {
      const writer = new YamlMcpConfigWriter({
        fileService,
        serverKeyPath: ['mcp_servers', 'brv'],
      })
      const filePath = path.join(testDir, 'config.yaml')

      const result = await writer.remove(filePath)

      expect(result).to.be.false
    })

    it('returns false when server entry does not exist', async () => {
      const writer = new YamlMcpConfigWriter({
        fileService,
        serverKeyPath: ['mcp_servers', 'brv'],
      })
      const filePath = path.join(testDir, 'config.yaml')
      await writeFile(filePath, yamlDump({mcp_servers: {other: {}}}))

      const result = await writer.remove(filePath)

      expect(result).to.be.false
    })

    it('removes server entry and preserves other settings', async () => {
      const writer = new YamlMcpConfigWriter({
        fileService,
        serverKeyPath: ['mcp_servers', 'brv'],
      })
      const filePath = path.join(testDir, 'config.yaml')
      await writeFile(
        filePath,
        yamlDump({mcp_servers: {brv: {command: 'brv'}, other: {command: 'other'}}, model: 'sonnet'}),
      )

      const result = await writer.remove(filePath)

      expect(result).to.be.true
      const parsed = yamlLoad(await readFile(filePath, 'utf8')) as Record<string, unknown>
      const servers = parsed.mcp_servers as Record<string, unknown>
      expect(servers.brv).to.be.undefined
      expect(servers.other).to.deep.equal({command: 'other'})
      expect(parsed.model).to.equal('sonnet')
    })

    it('returns true when server entry is removed', async () => {
      const writer = new YamlMcpConfigWriter({
        fileService,
        serverKeyPath: ['mcp_servers', 'brv'],
      })
      const filePath = path.join(testDir, 'config.yaml')
      await writeFile(filePath, yamlDump({mcp_servers: {brv: {command: 'brv'}}}))

      const result = await writer.remove(filePath)

      expect(result).to.be.true
    })
  })
})

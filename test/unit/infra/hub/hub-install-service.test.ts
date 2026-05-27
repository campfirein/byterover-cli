/* eslint-disable camelcase */
import {expect} from 'chai'
import nock from 'nock'
import {join} from 'node:path'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {IFileService} from '../../../../src/server/core/interfaces/services/i-file-service.js'
import type {SkillConnector} from '../../../../src/server/infra/connectors/skill/skill-connector.js'
import type {HubEntryDTO} from '../../../../src/shared/transport/types/dto.js'

import {ProxyConfig} from '../../../../src/server/infra/http/proxy-config.js'
import {HubInstallService} from '../../../../src/server/infra/hub/hub-install-service.js'

const FILE_HOST = 'https://raw.githubusercontent.com'

function createSkillEntry(overrides?: Pick<Partial<HubEntryDTO>, 'file_tree'>): HubEntryDTO {
  return {
    author: {name: 'Test', url: ''},
    category: 'code-review',
    dependencies: [],
    description: 'Test skill',
    file_tree: overrides?.file_tree ?? [
      {name: 'SKILL.md', url: `${FILE_HOST}/skill.md`},
      {name: 'README.md', url: `${FILE_HOST}/readme.md`},
      {name: 'manifest.json', url: `${FILE_HOST}/manifest.json`},
    ],
    id: 'test-skill',
    license: 'MIT',
    long_description: 'Full description',
    manifest_url: `${FILE_HOST}/manifest.json`,
    metadata: {use_cases: []},
    name: 'Test Skill',
    path_url: '',
    readme_url: `${FILE_HOST}/readme.md`,
    tags: [],
    type: 'agent-skill',
    version: '1.0.0',
  }
}

function createBundleEntry(overrides?: Pick<Partial<HubEntryDTO>, 'file_tree'>): HubEntryDTO {
  return {
    author: {name: 'Test', url: ''},
    category: 'setup',
    dependencies: [],
    description: 'Test bundle',
    file_tree: overrides?.file_tree ?? [
      {name: 'README.md', url: `${FILE_HOST}/readme.md`},
      {name: 'context.md', url: `${FILE_HOST}/context.md`},
      {name: 'manifest.json', url: `${FILE_HOST}/manifest.json`},
    ],
    id: 'test-bundle',
    license: 'MIT',
    long_description: 'Full description',
    manifest_url: `${FILE_HOST}/manifest.json`,
    metadata: {use_cases: []},
    name: 'Test Bundle',
    path_url: '',
    readme_url: `${FILE_HOST}/readme.md`,
    tags: [],
    type: 'bundle',
    version: '1.0.0',
  }
}

describe('HubInstallService', () => {
  let sandbox: SinonSandbox
  let fileService: {
    createBackup: SinonStub
    delete: SinonStub
    deleteDirectory: SinonStub
    exists: SinonStub
    read: SinonStub
    replaceContent: SinonStub
    write: SinonStub
  }
  let mockSkillConnector: {
    isSupported: SinonStub
    writeSkillFiles: SinonStub
  }
  let skillConnectorFactory: SinonStub
  let service: HubInstallService
  const projectPath = '/test/project'

  beforeEach(() => {
    sandbox = createSandbox()
    sandbox.stub(ProxyConfig, 'getProxyAgent').returns(undefined as never)
    fileService = {
      createBackup: sandbox.stub().resolves(''),
      delete: sandbox.stub().resolves(),
      deleteDirectory: sandbox.stub().resolves(),
      exists: sandbox.stub().resolves(false),
      read: sandbox.stub().resolves(''),
      replaceContent: sandbox.stub().resolves(),
      write: sandbox.stub().resolves(),
    }
    mockSkillConnector = {
      isSupported: sandbox.stub().returns(true),
      writeSkillFiles: sandbox.stub().resolves({
        alreadyInstalled: false,
        installedFiles: [join(projectPath, '.claude/skills/test-skill/SKILL.md')],
        installedPath: join(projectPath, '.claude/skills/test-skill'),
      }),
    }
    skillConnectorFactory = sandbox.stub().returns(mockSkillConnector)
    service = new HubInstallService({
      fileService: fileService as unknown as IFileService,
      skillConnectorFactory: skillConnectorFactory as unknown as (projectRoot: string) => SkillConnector,
    })
  })

  afterEach(() => {
    sandbox.restore()
    nock.cleanAll()
  })

  describe('skill install', () => {
    it('should delegate to SkillConnector.writeSkillFiles', async () => {
      nock(FILE_HOST).get('/skill.md').reply(200, '# Skill')

      const entry = createSkillEntry()
      const result = await service.install({agent: 'Claude Code', entry, projectPath})

      expect(skillConnectorFactory.calledWith(projectPath)).to.be.true
      expect(mockSkillConnector.writeSkillFiles.calledOnce).to.be.true

      const {agent, files, skillName} = mockSkillConnector.writeSkillFiles.firstCall.args[0] as {
        agent: string
        files: Array<{content: string; name: string}>
        skillName: string
      }
      expect(agent).to.equal('Claude Code')
      expect(skillName).to.equal('test-skill')
      expect(files).to.have.lengthOf(1)
      expect(files[0].name).to.equal('SKILL.md')
      expect(files[0].content).to.equal('# Skill')

      expect(result.installedFiles).to.have.lengthOf(1)
      expect(result.message).to.include('Claude Code')
      expect(result.message).to.include('.claude/skills/test-skill')
    })

    it('should skip if already installed', async () => {
      nock(FILE_HOST).get('/skill.md').reply(200, '# Skill')

      mockSkillConnector.writeSkillFiles.resolves({
        alreadyInstalled: true,
        installedFiles: [],
        installedPath: join(projectPath, '.claude/skills/test-skill'),
      })

      const entry = createSkillEntry()
      const result = await service.install({agent: 'Claude Code', entry, projectPath})

      expect(result.installedFiles).to.have.lengthOf(0)
      expect(result.message).to.include('already installed')
    })

    it('should throw if agent is not provided', async () => {
      const entry = createSkillEntry()

      try {
        await service.install({entry, projectPath})
        expect.fail('Should have thrown')
      } catch (error) {
        expect((error as Error).message).to.equal('Agent does not support skill installation')
      }
    })

    it('should filter out readme_url and manifest_url files before downloading', async () => {
      nock(FILE_HOST).get('/skill.md').reply(200, '# Skill')

      const entry = createSkillEntry()
      await service.install({agent: 'Claude Code', entry, projectPath})

      const {files} = mockSkillConnector.writeSkillFiles.firstCall.args[0] as {
        files: Array<{content: string; name: string}>
      }
      expect(files).to.have.lengthOf(1)
      expect(files[0].name).to.equal('SKILL.md')
    })

    it('should pass scope to writeSkillFiles', async () => {
      nock(FILE_HOST).get('/skill.md').reply(200, '# Skill')

      const entry = createSkillEntry()
      await service.install({agent: 'Claude Code', entry, projectPath, scope: 'global'})

      const {scope} = mockSkillConnector.writeSkillFiles.firstCall.args[0] as {scope?: string}
      expect(scope).to.equal('global')
    })

    it('should pass undefined scope when not specified', async () => {
      nock(FILE_HOST).get('/skill.md').reply(200, '# Skill')

      const entry = createSkillEntry()
      await service.install({agent: 'Claude Code', entry, projectPath})

      const {scope} = mockSkillConnector.writeSkillFiles.firstCall.args[0] as {scope?: string}
      expect(scope).to.be.undefined
    })
  })

  describe('bundle install', () => {
    it('should install only context files to context tree', async () => {
      nock(FILE_HOST).get('/context.md').reply(200, '# Context')

      const entry = createBundleEntry()
      const result = await service.install({entry, projectPath})

      expect(result.installedFiles).to.have.lengthOf(1)
      expect(result.message).to.include('context tree')

      expect(fileService.write.calledOnce).to.be.true
      expect(fileService.write.calledWith('# Context', join(projectPath, '.brv/context-tree/context.md'), 'overwrite'))
        .to.be.true
    })

    it('should not install README.md or manifest.json to context tree', async () => {
      nock(FILE_HOST).get('/context.md').reply(200, '# Context')

      const entry = createBundleEntry()
      await service.install({entry, projectPath})

      expect(fileService.write.callCount).to.equal(1)
      const writtenPath = fileService.write.firstCall.args[1] as string
      expect(writtenPath).to.include('context.md')
      expect(writtenPath).to.not.include('README.md')
      expect(writtenPath).to.not.include('manifest.json')
    })

    it('should preserve nested file_tree paths', async () => {
      nock(FILE_HOST).get('/auth-context.md').reply(200, '# Auth')
      nock(FILE_HOST).get('/test-context.md').reply(200, '# Test')

      const entry = createBundleEntry({
        file_tree: [
          {name: 'auth/context.md', url: `${FILE_HOST}/auth-context.md`},
          {name: 'test/context.md', url: `${FILE_HOST}/test-context.md`},
          {name: 'manifest.json', url: `${FILE_HOST}/manifest.json`},
        ],
      })

      const result = await service.install({entry, projectPath})

      expect(result.installedFiles).to.have.lengthOf(2)
      expect(
        fileService.write.calledWith('# Auth', join(projectPath, '.brv/context-tree/auth/context.md'), 'overwrite'),
      ).to.be.true
      expect(
        fileService.write.calledWith('# Test', join(projectPath, '.brv/context-tree/test/context.md'), 'overwrite'),
      ).to.be.true
    })

    it('should skip if already installed', async () => {
      fileService.exists.resolves(true)

      const entry = createBundleEntry()
      const result = await service.install({entry, projectPath})

      expect(result.installedFiles).to.have.lengthOf(0)
      expect(result.message).to.include('already installed')
      expect(fileService.write.called).to.be.false
    })

    it('should not require agent parameter', async () => {
      nock(FILE_HOST).get('/context.md').reply(200, '# Context')

      const entry = createBundleEntry()
      const result = await service.install({entry, projectPath})

      expect(result.installedFiles).to.have.lengthOf(1)
    })

    it('should ignore scope for bundles', async () => {
      nock(FILE_HOST).get('/context.md').reply(200, '# Context')

      const entry = createBundleEntry()
      const result = await service.install({entry, projectPath, scope: 'global'})

      expect(result.installedFiles).to.have.lengthOf(1)
      expect(result.message).to.include('context tree')
      // Scope should not affect bundle install — still goes to context tree
      expect(fileService.write.calledWith('# Context', join(projectPath, '.brv/context-tree/context.md'), 'overwrite'))
        .to.be.true
    })
  })

  describe('auth', () => {
    it('should pass Bearer auth header by default when authToken is provided', async () => {
      nock(FILE_HOST).get('/skill.md').matchHeader('authorization', 'Bearer my-secret').reply(200, '# Skill')

      const entry = createSkillEntry()
      const result = await service.install({
        agent: 'Claude Code',
        auth: {authToken: 'my-secret'},
        entry,
        projectPath,
      })

      expect(result.installedFiles).to.have.lengthOf(1)
    })

    it('should pass Bearer auth header for bundle downloads', async () => {
      nock(FILE_HOST).get('/context.md').matchHeader('authorization', 'Bearer bundle-token').reply(200, '# Context')

      const entry = createBundleEntry()
      const result = await service.install({
        auth: {authToken: 'bundle-token'},
        entry,
        projectPath,
      })

      expect(result.installedFiles).to.have.lengthOf(1)
    })

    it('should use token scheme when specified', async () => {
      nock(FILE_HOST).get('/skill.md').matchHeader('authorization', 'token ghp_abc123').reply(200, '# Skill')

      const entry = createSkillEntry()
      const result = await service.install({
        agent: 'Claude Code',
        auth: {authScheme: 'token', authToken: 'ghp_abc123'},
        entry,
        projectPath,
      })

      expect(result.installedFiles).to.have.lengthOf(1)
    })

    it('should use custom header when specified', async () => {
      nock(FILE_HOST).get('/context.md').matchHeader('PRIVATE-TOKEN', 'glpat-xxx').reply(200, '# Context')

      const entry = createBundleEntry()
      const result = await service.install({
        auth: {authScheme: 'custom-header', authToken: 'glpat-xxx', headerName: 'PRIVATE-TOKEN'},
        entry,
        projectPath,
      })

      expect(result.installedFiles).to.have.lengthOf(1)
    })

    it('should send no auth header when scheme is none', async () => {
      nock(FILE_HOST)
        .get('/skill.md')
        .reply(function () {
          expect(this.req.headers.authorization).to.be.undefined
          return [200, '# Skill']
        })

      const entry = createSkillEntry()
      const result = await service.install({
        agent: 'Claude Code',
        auth: {authScheme: 'none', authToken: 'should-be-ignored'},
        entry,
        projectPath,
      })

      expect(result.installedFiles).to.have.lengthOf(1)
    })
  })
})

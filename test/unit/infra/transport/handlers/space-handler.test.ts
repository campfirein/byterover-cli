import type {SinonStubbedInstance} from 'sinon'

import {expect} from 'chai'
import {restore, stub} from 'sinon'

import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'
import type {ITokenStore} from '../../../../../src/server/core/interfaces/auth/i-token-store.js'
import type {IContextTreeMerger} from '../../../../../src/server/core/interfaces/context-tree/i-context-tree-merger.js'
import type {IContextTreeService} from '../../../../../src/server/core/interfaces/context-tree/i-context-tree-service.js'
import type {IContextTreeSnapshotService} from '../../../../../src/server/core/interfaces/context-tree/i-context-tree-snapshot-service.js'
import type {IContextTreeWriterService} from '../../../../../src/server/core/interfaces/context-tree/i-context-tree-writer-service.js'
import type {ICogitPullService} from '../../../../../src/server/core/interfaces/services/i-cogit-pull-service.js'
import type {ISpaceService} from '../../../../../src/server/core/interfaces/services/i-space-service.js'
import type {ITeamService} from '../../../../../src/server/core/interfaces/services/i-team-service.js'
import type {IProjectConfigStore} from '../../../../../src/server/core/interfaces/storage/i-project-config-store.js'
import type {ITransportServer} from '../../../../../src/server/core/interfaces/transport/i-transport-server.js'
import type {ProjectBroadcaster} from '../../../../../src/server/infra/transport/handlers/handler-types.js'

import {BRV_CONFIG_VERSION} from '../../../../../src/server/constants.js'
import {AuthToken} from '../../../../../src/server/core/domain/entities/auth-token.js'
import {BrvConfig} from '../../../../../src/server/core/domain/entities/brv-config.js'
import {CogitSnapshotAuthor} from '../../../../../src/server/core/domain/entities/cogit-snapshot-author.js'
import {CogitSnapshotFile} from '../../../../../src/server/core/domain/entities/cogit-snapshot-file.js'
import {CogitSnapshot} from '../../../../../src/server/core/domain/entities/cogit-snapshot.js'
import {Space} from '../../../../../src/server/core/domain/entities/space.js'
import {Team} from '../../../../../src/server/core/domain/entities/team.js'
import {
  GitVcInitializedError,
  LocalChangesExistError,
  NotAuthenticatedError,
  ProjectNotInitError,
} from '../../../../../src/server/core/domain/errors/task-error.js'
import {SpaceHandler} from '../../../../../src/server/infra/transport/handlers/space-handler.js'
import {AnalyticsEventNames} from '../../../../../src/shared/analytics/event-names.js'
import {PullEvents} from '../../../../../src/shared/transport/events/pull-events.js'
import {SpaceEvents} from '../../../../../src/shared/transport/events/space-events.js'

// ==================== Test Helpers ====================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (data: any, clientId: string) => any

function createMockTransport(): SinonStubbedInstance<ITransportServer> & {_handlers: Map<string, AnyHandler>} {
  const handlers = new Map<string, AnyHandler>()
  return {
    _handlers: handlers,
    addToRoom: stub(),
    broadcast: stub(),
    broadcastTo: stub(),
    getPort: stub(),
    isRunning: stub(),
    onConnection: stub(),
    onDisconnection: stub(),
    onRequest: stub().callsFake((event: string, handler: AnyHandler) => {
      handlers.set(event, handler)
    }),
    removeFromRoom: stub(),
    sendTo: stub(),
    start: stub(),
    stop: stub(),
  } as unknown as SinonStubbedInstance<ITransportServer> & {_handlers: Map<string, AnyHandler>}
}

const createMockToken = (): AuthToken =>
  new AuthToken({
    accessToken: 'access-token',
    expiresAt: new Date(Date.now() + 3600 * 1000),
    refreshToken: 'refresh-token',
    sessionKey: 'session-key',
    tokenType: 'Bearer',
    userEmail: 'user@example.com',
    userId: 'user-123',
  })

const createExpiredToken = (): AuthToken =>
  new AuthToken({
    accessToken: 'access-token',
    expiresAt: new Date(Date.now() - 1000),
    refreshToken: 'refresh-token',
    sessionKey: 'session-key',
    tokenType: 'Bearer',
    userEmail: 'user@example.com',
    userId: 'user-expired',
  })

const createMockConfig = (): BrvConfig =>
  new BrvConfig({
    chatLogPath: 'chat.log',
    createdAt: '2024-01-01T00:00:00.000Z',
    cwd: '/test/cwd',
    ide: 'Claude Code',
    spaceId: 'space-1',
    spaceName: 'frontend-app',
    teamId: 'team-1',
    teamName: 'acme-corp',
    version: BRV_CONFIG_VERSION,
  })

const createLocalOnlyConfig = (): BrvConfig =>
  new BrvConfig({
    createdAt: '2024-01-01T00:00:00.000Z',
    cwd: '/test/cwd',
    version: BRV_CONFIG_VERSION,
  })

const createMockTeams = (): Team[] => [
  new Team({
    avatarUrl: '',
    createdAt: new Date(),
    description: '',
    displayName: 'Acme Corp',
    id: 'team-1',
    isActive: true,
    isDefault: true,
    name: 'acme-corp',
    slug: 'acme-corp',
    updatedAt: new Date(),
  }),
  new Team({
    avatarUrl: '',
    createdAt: new Date(),
    description: '',
    displayName: 'Other Team',
    id: 'team-2',
    isActive: true,
    isDefault: false,
    name: 'other-team',
    slug: 'other-team',
    updatedAt: new Date(),
  }),
]

const createMockSpaces = (): Space[] => [
  new Space({id: 'space-1', isDefault: true, name: 'frontend-app', teamId: 'team-1', teamName: 'acme-corp'}),
  new Space({id: 'space-2', isDefault: false, name: 'backend-api', teamId: 'team-1', teamName: 'acme-corp'}),
]

const createMockSnapshot = (): CogitSnapshot =>
  new CogitSnapshot({
    author: new CogitSnapshotAuthor({email: 'user@example.com', name: 'User', when: '2024-01-01T00:00:00Z'}),
    branch: 'main',
    commitSha: 'abc1234567890',
    files: [new CogitSnapshotFile({content: 'IyBUZXN0', mode: '100644', path: 'test.md', sha: 'abc123', size: 6})],
    message: 'snapshot',
  })

const noChanges = () => ({added: [], deleted: [], modified: []})
const withChanges = () => ({added: ['new-file.md'], deleted: [], modified: []})

// ==================== Tests ====================

describe('SpaceHandler', () => {
  let broadcastToProject: ReturnType<typeof stub>
  let cogitPullService: SinonStubbedInstance<ICogitPullService>
  let contextTreeMerger: SinonStubbedInstance<IContextTreeMerger>
  let contextTreeService: {hasGitRepo: ReturnType<typeof stub>}
  let contextTreeSnapshotService: SinonStubbedInstance<IContextTreeSnapshotService>
  let contextTreeWriterService: SinonStubbedInstance<IContextTreeWriterService>
  let projectConfigStore: SinonStubbedInstance<IProjectConfigStore>
  let resolveProjectPath: ReturnType<typeof stub>
  let spaceService: SinonStubbedInstance<ISpaceService>
  let teamService: SinonStubbedInstance<ITeamService>
  let tokenStore: SinonStubbedInstance<ITokenStore>
  let transport: ReturnType<typeof createMockTransport>

  beforeEach(() => {
    broadcastToProject = stub() as unknown as ProjectBroadcaster & ReturnType<typeof stub>

    cogitPullService = {
      pull: stub(),
    }

    contextTreeMerger = {
      merge: stub<Parameters<IContextTreeMerger['merge']>, ReturnType<IContextTreeMerger['merge']>>().resolves({
        added: [],
        conflicted: [],
        deleted: [],
        edited: [],
        restoredFromRemote: [],
      }),
    }

    contextTreeService = {
      hasGitRepo: stub().resolves(false),
    }

    contextTreeSnapshotService = {
      getChanges: stub(),
      getCurrentState: stub(),
      getSnapshotState: stub(),
      hasSnapshot: stub(),
      initEmptySnapshot: stub(),
      saveSnapshot: stub(),
      saveSnapshotFromState: stub(),
    }

    contextTreeWriterService = {
      sync: stub(),
    }

    projectConfigStore = {
      exists: stub(),
      getModifiedTime: stub(),
      read: stub(),
      write: stub(),
    }

    tokenStore = {
      clear: stub(),
      load: stub(),
      save: stub(),
    }

    spaceService = {
      getSpaces: stub(),
    }

    teamService = {
      getTeams: stub(),
    }

    resolveProjectPath = stub().returns('/test/project')
    transport = createMockTransport()
  })

  afterEach(() => {
    restore()
  })

  function createHandler(): SpaceHandler {
    const handler = new SpaceHandler({
      broadcastToProject,
      cogitPullService,
      contextTreeMerger,
      contextTreeService: contextTreeService as unknown as IContextTreeService,
      contextTreeSnapshotService,
      contextTreeWriterService,
      projectConfigStore,
      resolveProjectPath,
      spaceService,
      teamService,
      tokenStore,
      transport,
    })
    handler.setup()
    return handler
  }

  async function callListHandler(
    clientId = 'client-1',
  ): Promise<{teams: Array<{spaces: unknown[]; teamId: string; teamName: string}>}> {
    const handler = transport._handlers.get(SpaceEvents.LIST)
    expect(handler, 'space:list handler should be registered').to.exist
    return handler!(undefined, clientId)
  }

  async function callSwitchHandler(
    data: {spaceId: string},
    clientId = 'client-1',
  ): Promise<{config?: unknown; error?: string; pullError?: string; pullResult?: unknown; success: boolean}> {
    const handler = transport._handlers.get(SpaceEvents.SWITCH)
    expect(handler, 'space:switch handler should be registered').to.exist
    return handler!(data, clientId)
  }

  describe('setup', () => {
    it('should register space:list and space:switch handlers', () => {
      createHandler()
      expect(transport.onRequest.calledTwice).to.be.true
      expect(transport._handlers.has(SpaceEvents.LIST)).to.be.true
      expect(transport._handlers.has(SpaceEvents.SWITCH)).to.be.true
    })
  })

  describe('handleList', () => {
    it('should return teams with spaces when authenticated and initialized', async () => {
      createHandler()
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves(createMockConfig())
      teamService.getTeams.resolves({teams: createMockTeams(), total: 2})
      spaceService.getSpaces
        .withArgs('session-key', 'team-1', {fetchAll: true})
        .resolves({spaces: createMockSpaces(), total: 2})
      spaceService.getSpaces.withArgs('session-key', 'team-2', {fetchAll: true}).resolves({spaces: [], total: 0})

      const result = await callListHandler()

      expect(result.teams).to.have.lengthOf(2)
      expect(result.teams[0].teamId).to.equal('team-1')
      expect(result.teams[0].teamName).to.equal('acme-corp')
      expect(result.teams[0].spaces).to.have.lengthOf(2)
      expect(result.teams[0].spaces[0]).to.deep.include({id: 'space-1', name: 'frontend-app'})
      expect(result.teams[1].teamId).to.equal('team-2')
      expect(result.teams[1].spaces).to.have.lengthOf(0)
    })

    it('should throw when not authenticated', async () => {
      createHandler()
      tokenStore.load.resolves()

      try {
        await callListHandler()
        expect.fail('should have thrown')
      } catch (error) {
        expect(error).to.be.instanceOf(NotAuthenticatedError)
      }
    })

    it('should throw when token is expired', async () => {
      createHandler()
      tokenStore.load.resolves(createExpiredToken())

      try {
        await callListHandler()
        expect.fail('should have thrown')
      } catch (error) {
        expect(error).to.be.instanceOf(NotAuthenticatedError)
      }
    })

    it('should throw when project not initialized', async () => {
      createHandler()
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves()

      try {
        await callListHandler()
        expect.fail('should have thrown')
      } catch (error) {
        expect(error).to.be.instanceOf(ProjectNotInitError)
      }
    })

    it('should fetch spaces for each team', async () => {
      createHandler()
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves(createMockConfig())
      teamService.getTeams.resolves({teams: createMockTeams(), total: 2})
      spaceService.getSpaces.resolves({spaces: [], total: 0})

      await callListHandler()

      expect(teamService.getTeams.calledWith('session-key', {fetchAll: true})).to.be.true
      expect(spaceService.getSpaces.calledWith('session-key', 'team-1', {fetchAll: true})).to.be.true
      expect(spaceService.getSpaces.calledWith('session-key', 'team-2', {fetchAll: true})).to.be.true
    })

    it('should return empty teams array when no teams found', async () => {
      createHandler()
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves(createMockConfig())
      teamService.getTeams.resolves({teams: [], total: 0})

      const result = await callListHandler()

      expect(result.teams).to.have.lengthOf(0)
    })

    it('should resolve project path from clientId', async () => {
      createHandler()
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves(createMockConfig())
      teamService.getTeams.resolves({teams: [], total: 0})

      await callListHandler('client-42')

      expect(resolveProjectPath.calledWith('client-42')).to.be.true
      expect(projectConfigStore.read.calledWith('/test/project')).to.be.true
    })
  })

  function setupSwitchMocks(config?: BrvConfig): void {
    tokenStore.load.resolves(createMockToken())
    projectConfigStore.read.resolves(config ?? createMockConfig())
    contextTreeSnapshotService.getChanges.resolves(noChanges())
    teamService.getTeams.resolves({teams: createMockTeams(), total: 2})
    spaceService.getSpaces
      .withArgs('session-key', 'team-1', {fetchAll: true})
      .resolves({spaces: createMockSpaces(), total: 2})
    spaceService.getSpaces.withArgs('session-key', 'team-2', {fetchAll: true}).resolves({spaces: [], total: 0})
    projectConfigStore.write.resolves()
    cogitPullService.pull.resolves(createMockSnapshot())
    contextTreeWriterService.sync.resolves({added: ['test.md'], deleted: [], edited: []})
    contextTreeSnapshotService.saveSnapshot.resolves()
  }

  describe('handleSwitch', () => {
    it('should switch space successfully', async () => {
      createHandler()
      setupSwitchMocks()

      const result = await callSwitchHandler({spaceId: 'space-2'})

      expect(result.success).to.be.true
      expect(result.config).to.deep.include({
        spaceId: 'space-2',
        spaceName: 'backend-api',
        teamId: 'team-1',
        teamName: 'acme-corp',
      })
    })

    it('should search across all teams to find target space', async () => {
      createHandler()
      setupSwitchMocks()

      await callSwitchHandler({spaceId: 'space-2'})

      expect(teamService.getTeams.calledWith('session-key', {fetchAll: true})).to.be.true
      expect(spaceService.getSpaces.calledWith('session-key', 'team-1', {fetchAll: true})).to.be.true
    })

    it('should throw when not authenticated', async () => {
      createHandler()
      tokenStore.load.resolves()

      try {
        await callSwitchHandler({spaceId: 'space-2'})
        expect.fail('should have thrown')
      } catch (error) {
        expect(error).to.be.instanceOf(NotAuthenticatedError)
      }
    })

    it('should throw when token is expired', async () => {
      createHandler()
      tokenStore.load.resolves(createExpiredToken())

      try {
        await callSwitchHandler({spaceId: 'space-2'})
        expect.fail('should have thrown')
      } catch (error) {
        expect(error).to.be.instanceOf(NotAuthenticatedError)
      }
    })

    it('should throw when project not initialized', async () => {
      createHandler()
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves()

      try {
        await callSwitchHandler({spaceId: 'space-2'})
        expect.fail('should have thrown')
      } catch (error) {
        expect(error).to.be.instanceOf(ProjectNotInitError)
      }
    })

    it('should throw when target space not found in any team', async () => {
      createHandler()
      setupSwitchMocks()

      try {
        await callSwitchHandler({spaceId: 'nonexistent-space'})
        expect.fail('should have thrown')
      } catch (error) {
        expect((error as Error).message).to.equal('Space not found')
      }
    })

    it('should write new config with updated space fields', async () => {
      createHandler()
      setupSwitchMocks()

      await callSwitchHandler({spaceId: 'space-2'})

      expect(projectConfigStore.write.calledOnce).to.be.true
      const writtenConfig = projectConfigStore.write.firstCall.args[0] as BrvConfig
      expect(writtenConfig.spaceId).to.equal('space-2')
      expect(writtenConfig.spaceName).to.equal('backend-api')
      expect(writtenConfig.teamId).to.equal('team-1')
      expect(writtenConfig.teamName).to.equal('acme-corp')
    })

    it('should preserve existing config fields when switching space', async () => {
      const existingConfig = new BrvConfig({
        chatLogPath: 'chat.log',
        cipherAgentContext: 'existing context',
        cipherAgentModes: ['mode1', 'mode2'],
        cipherAgentSystemPrompt: 'existing prompt',
        createdAt: '2024-01-01T00:00:00.000Z',
        cwd: '/test/cwd',
        ide: 'Claude Code',
        spaceId: 'space-1',
        spaceName: 'frontend-app',
        teamId: 'team-1',
        teamName: 'acme-corp',
        version: BRV_CONFIG_VERSION,
      })

      createHandler()
      setupSwitchMocks(existingConfig)

      await callSwitchHandler({spaceId: 'space-2'})

      const writtenConfig = projectConfigStore.write.firstCall.args[0] as BrvConfig
      expect(writtenConfig.chatLogPath).to.equal('chat.log')
      expect(writtenConfig.cwd).to.equal('/test/cwd')
      expect(writtenConfig.ide).to.equal('Claude Code')
      expect(writtenConfig.cipherAgentContext).to.equal('existing context')
      expect(writtenConfig.cipherAgentModes).to.deep.equal(['mode1', 'mode2'])
      expect(writtenConfig.cipherAgentSystemPrompt).to.equal('existing prompt')
    })

    it('should resolve project path from clientId', async () => {
      createHandler()
      setupSwitchMocks()

      await callSwitchHandler({spaceId: 'space-2'}, 'client-42')

      expect(resolveProjectPath.calledWith('client-42')).to.be.true
    })

    it('should throw when project path is undefined', async () => {
      // eslint-disable-next-line unicorn/no-useless-undefined
      resolveProjectPath.returns(undefined)
      createHandler()
      tokenStore.load.resolves(createMockToken())

      try {
        await callSwitchHandler({spaceId: 'space-2'})
        expect.fail('should have thrown')
      } catch (error) {
        expect((error as Error).message).to.include('No project path found for client')
      }
    })

    it('should work with local-only config (no teamId)', async () => {
      createHandler()
      setupSwitchMocks(createLocalOnlyConfig())

      const result = await callSwitchHandler({spaceId: 'space-2'})

      expect(teamService.getTeams.calledWith('session-key', {fetchAll: true})).to.be.true
      expect(result.success).to.be.true
      expect(result.config).to.deep.include({spaceId: 'space-2', spaceName: 'backend-api'})
    })

    // ==================== Local Changes Detection ====================

    it('should throw LocalChangesExistError when added changes exist and space already configured', async () => {
      createHandler()
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves(createMockConfig()) // has spaceId already
      contextTreeSnapshotService.getChanges.resolves({added: ['new.md'], deleted: [], modified: []})
      teamService.getTeams.resolves({teams: createMockTeams(), total: 2})

      try {
        await callSwitchHandler({spaceId: 'space-2'})
        expect.fail('should have thrown')
      } catch (error) {
        expect(error).to.be.instanceOf(LocalChangesExistError)
      }
    })

    it('should throw LocalChangesExistError when modified changes exist and space already configured', async () => {
      createHandler()
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves(createMockConfig())
      contextTreeSnapshotService.getChanges.resolves({added: [], deleted: [], modified: ['changed.md']})
      teamService.getTeams.resolves({teams: createMockTeams(), total: 2})

      try {
        await callSwitchHandler({spaceId: 'space-2'})
        expect.fail('should have thrown')
      } catch (error) {
        expect(error).to.be.instanceOf(LocalChangesExistError)
      }
    })

    it('should throw LocalChangesExistError when deleted changes exist and space already configured', async () => {
      createHandler()
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves(createMockConfig())
      contextTreeSnapshotService.getChanges.resolves({added: [], deleted: ['removed.md'], modified: []})
      teamService.getTeams.resolves({teams: createMockTeams(), total: 2})

      try {
        await callSwitchHandler({spaceId: 'space-2'})
        expect.fail('should have thrown')
      } catch (error) {
        expect(error).to.be.instanceOf(LocalChangesExistError)
      }
    })

    it('should allow first-time space connect with local changes (no prior spaceId)', async () => {
      createHandler()
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves(createLocalOnlyConfig()) // no spaceId
      contextTreeSnapshotService.getChanges.resolves(withChanges())
      teamService.getTeams.resolves({teams: createMockTeams(), total: 2})
      spaceService.getSpaces
        .withArgs('session-key', 'team-1', {fetchAll: true})
        .resolves({spaces: createMockSpaces(), total: 2})
      spaceService.getSpaces.withArgs('session-key', 'team-2', {fetchAll: true}).resolves({spaces: [], total: 0})
      projectConfigStore.write.resolves()
      cogitPullService.pull.resolves(createMockSnapshot())
      contextTreeSnapshotService.saveSnapshotFromState.resolves()

      const result = await callSwitchHandler({spaceId: 'space-2'})

      expect(result.success).to.be.true
    })

    it('should use merger when local changes exist on first-time space connect', async () => {
      createHandler()
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves(createLocalOnlyConfig()) // no spaceId
      contextTreeSnapshotService.getChanges.resolves(withChanges())
      teamService.getTeams.resolves({teams: createMockTeams(), total: 2})
      spaceService.getSpaces
        .withArgs('session-key', 'team-1', {fetchAll: true})
        .resolves({spaces: createMockSpaces(), total: 2})
      spaceService.getSpaces.withArgs('session-key', 'team-2', {fetchAll: true}).resolves({spaces: [], total: 0})
      projectConfigStore.write.resolves()
      cogitPullService.pull.resolves(createMockSnapshot())
      contextTreeSnapshotService.saveSnapshotFromState.resolves()

      await callSwitchHandler({spaceId: 'space-2'})

      expect(contextTreeMerger.merge.calledOnce).to.be.true
      // preserveLocalFiles must be true for first-time connect
      const mergeCall = contextTreeMerger.merge.firstCall.args[0]
      expect(mergeCall.preserveLocalFiles).to.be.true
      // Regular sync should NOT be called
      expect(contextTreeWriterService.sync.called).to.be.false
    })

    it('should use merger with preserveLocalFiles=true on first-time connect even when no local changes', async () => {
      createHandler()
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves(createLocalOnlyConfig()) // no spaceId — first-time connect
      contextTreeSnapshotService.getChanges.resolves(noChanges()) // no added/modified/deleted
      teamService.getTeams.resolves({teams: createMockTeams(), total: 2})
      spaceService.getSpaces
        .withArgs('session-key', 'team-1', {fetchAll: true})
        .resolves({spaces: createMockSpaces(), total: 2})
      spaceService.getSpaces.withArgs('session-key', 'team-2', {fetchAll: true}).resolves({spaces: [], total: 0})
      projectConfigStore.write.resolves()
      cogitPullService.pull.resolves(createMockSnapshot())
      contextTreeSnapshotService.saveSnapshotFromState.resolves()

      await callSwitchHandler({spaceId: 'space-2'})

      // Merger must be called even with no local changes — tracked+clean files in the local
      // context tree must not be deleted when connecting to a space for the first time.
      expect(contextTreeMerger.merge.calledOnce).to.be.true
      const mergeCall = contextTreeMerger.merge.firstCall.args[0]
      expect(mergeCall.preserveLocalFiles).to.be.true
      // Regular sync must NOT be called — it would silently delete all local tracked files
      expect(contextTreeWriterService.sync.called).to.be.false
    })

    it('should check changes with the correct project path', async () => {
      createHandler()
      setupSwitchMocks()

      await callSwitchHandler({spaceId: 'space-2'})

      expect(contextTreeSnapshotService.getChanges.calledWith('/test/project')).to.be.true
    })

    // ==================== Auto-Pull After Switch ====================

    it('should pull context from new space after switching', async () => {
      createHandler()
      setupSwitchMocks()

      await callSwitchHandler({spaceId: 'space-2'})

      expect(cogitPullService.pull.calledOnce).to.be.true
      const pullArgs = cogitPullService.pull.firstCall.args[0]
      expect(pullArgs.branch).to.equal('main')
      expect(pullArgs.sessionKey).to.equal('session-key')
      expect(pullArgs.spaceId).to.equal('space-2')
      expect(pullArgs.teamId).to.equal('team-1')
    })

    it('should sync pulled files and save snapshot when no local changes', async () => {
      createHandler()
      setupSwitchMocks()

      await callSwitchHandler({spaceId: 'space-2'})

      expect(contextTreeWriterService.sync.calledOnce).to.be.true
      expect(contextTreeSnapshotService.saveSnapshot.calledOnce).to.be.true
    })

    it('should return pullResult with stats on successful pull', async () => {
      createHandler()
      setupSwitchMocks()
      contextTreeWriterService.sync.resolves({added: ['a.md', 'b.md'], deleted: ['c.md'], edited: ['d.md']})

      const result = await callSwitchHandler({spaceId: 'space-2'})

      expect(result.pullResult).to.deep.equal({
        added: 2,
        commitSha: 'abc1234567890',
        deleted: 1,
        edited: 1,
      })
      expect(result.pullError).to.be.undefined
    })

    it('should return success: false and pullError when pull fails', async () => {
      createHandler()
      setupSwitchMocks()
      cogitPullService.pull.rejects(new Error('Not found'))

      const result = await callSwitchHandler({spaceId: 'space-2'})

      expect(result.success).to.be.false
      expect(result.pullResult).to.be.undefined
      expect(result.pullError).to.equal('Not found')
    })

    it('should not write config when pull fails — config stays on old spaceId', async () => {
      createHandler()
      setupSwitchMocks() // config starts with spaceId: 'space-1'
      cogitPullService.pull.rejects(new Error('Network error'))

      const result = await callSwitchHandler({spaceId: 'space-2'})

      // Config must NOT be written at all — disk state is unchanged
      expect(projectConfigStore.write.called).to.be.false
      // Response returns old config
      expect(result.config).to.deep.include({spaceId: 'space-1'})
    })

    it('should write config with new spaceId only after pull succeeds', async () => {
      createHandler()
      setupSwitchMocks() // config starts with spaceId: 'space-1'

      const result = await callSwitchHandler({spaceId: 'space-2'})

      expect(result.success).to.be.true
      // Write called exactly once, with new spaceId (not before pull)
      expect(projectConfigStore.write.calledOnce).to.be.true
      const writtenConfig = projectConfigStore.write.firstCall.args[0] as BrvConfig
      expect(writtenConfig.spaceId).to.equal('space-2')
    })

    it('should broadcast progress events during pull', async () => {
      createHandler()
      setupSwitchMocks()

      await callSwitchHandler({spaceId: 'space-2'})

      expect(broadcastToProject.calledWith('/test/project', PullEvents.PROGRESS)).to.be.true
    })

    it('should count renamed files as added in pullResult when using merger path', async () => {
      createHandler()
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves(createLocalOnlyConfig()) // no spaceId
      contextTreeSnapshotService.getChanges.resolves(withChanges())
      teamService.getTeams.resolves({teams: createMockTeams(), total: 2})
      spaceService.getSpaces
        .withArgs('session-key', 'team-1', {fetchAll: true})
        .resolves({spaces: createMockSpaces(), total: 2})
      spaceService.getSpaces.withArgs('session-key', 'team-2', {fetchAll: true}).resolves({spaces: [], total: 0})
      projectConfigStore.write.resolves()
      cogitPullService.pull.resolves(createMockSnapshot())
      contextTreeMerger.merge.resolves({
        added: ['new.md', 'conflict_1.md'],
        conflicted: [],
        deleted: [],
        edited: [],
        restoredFromRemote: [],
      })
      contextTreeSnapshotService.saveSnapshotFromState.resolves()

      const result = await callSwitchHandler({spaceId: 'space-2'})

      expect(result.success).to.be.true
      // conflict_1.md (preserved local) is already in added — no separate renamed count
      expect(result.pullResult).to.deep.include({
        added: 2,
        commitSha: 'abc1234567890',
        deleted: 0,
        edited: 0,
      })
    })

    it('should include conflicted count in pullResult and broadcast conflict message when conflicts exist', async () => {
      createHandler()
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves(createLocalOnlyConfig()) // no spaceId
      contextTreeSnapshotService.getChanges.resolves(withChanges())
      teamService.getTeams.resolves({teams: createMockTeams(), total: 2})
      spaceService.getSpaces
        .withArgs('session-key', 'team-1', {fetchAll: true})
        .resolves({spaces: createMockSpaces(), total: 2})
      spaceService.getSpaces.withArgs('session-key', 'team-2', {fetchAll: true}).resolves({spaces: [], total: 0})
      projectConfigStore.write.resolves()
      cogitPullService.pull.resolves(createMockSnapshot())
      contextTreeMerger.merge.resolves({
        added: ['topic_1.md'],
        conflicted: ['topic.md'],
        deleted: [],
        edited: [],
        restoredFromRemote: [],
      })
      contextTreeSnapshotService.saveSnapshotFromState.resolves()

      const result = await callSwitchHandler({spaceId: 'space-2'})

      expect(result.success).to.be.true
      expect(result.pullResult).to.deep.include({conflicted: 1})

      // Handler must broadcast the conflict review message
      const conflictBroadcast = broadcastToProject.getCalls().find((call: {args: unknown[]}) => {
        const data = call.args[2] as undefined | {message?: string}
        return call.args[1] === PullEvents.PROGRESS && data?.message?.includes('context-tree-conflicts')
      })
      expect(conflictBroadcast, 'conflict message should be broadcast').to.exist
    })

    it('should not set conflicted in pullResult when merger returns no conflicts', async () => {
      createHandler()
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves(createLocalOnlyConfig())
      contextTreeSnapshotService.getChanges.resolves(withChanges())
      teamService.getTeams.resolves({teams: createMockTeams(), total: 2})
      spaceService.getSpaces
        .withArgs('session-key', 'team-1', {fetchAll: true})
        .resolves({spaces: createMockSpaces(), total: 2})
      spaceService.getSpaces.withArgs('session-key', 'team-2', {fetchAll: true}).resolves({spaces: [], total: 0})
      projectConfigStore.write.resolves()
      cogitPullService.pull.resolves(createMockSnapshot())
      contextTreeMerger.merge.resolves({
        added: ['new.md'],
        conflicted: [],
        deleted: [],
        edited: [],
        restoredFromRemote: [],
      })
      contextTreeSnapshotService.saveSnapshotFromState.resolves()

      const result = await callSwitchHandler({spaceId: 'space-2'})

      expect(result.success).to.be.true
      expect(result.pullResult).to.not.have.property('conflicted')
    })

    it('should use merger when only deleted changes exist on first-time connect', async () => {
      createHandler()
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves(createLocalOnlyConfig()) // no spaceId
      contextTreeSnapshotService.getChanges.resolves({added: [], deleted: ['old.md'], modified: []})
      teamService.getTeams.resolves({teams: createMockTeams(), total: 2})
      spaceService.getSpaces
        .withArgs('session-key', 'team-1', {fetchAll: true})
        .resolves({spaces: createMockSpaces(), total: 2})
      spaceService.getSpaces.withArgs('session-key', 'team-2', {fetchAll: true}).resolves({spaces: [], total: 0})
      projectConfigStore.write.resolves()
      cogitPullService.pull.resolves(createMockSnapshot())
      contextTreeSnapshotService.saveSnapshotFromState.resolves()

      await callSwitchHandler({spaceId: 'space-2'})

      expect(contextTreeMerger.merge.calledOnce).to.be.true
      expect(contextTreeWriterService.sync.called).to.be.false
    })

    // ==================== restoredFromRemote ====================

    it('should include restoredFromRemote count in pullResult and broadcast restore message', async () => {
      createHandler()
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves(createLocalOnlyConfig()) // no spaceId
      contextTreeSnapshotService.getChanges.resolves(withChanges())
      teamService.getTeams.resolves({teams: createMockTeams(), total: 2})
      spaceService.getSpaces
        .withArgs('session-key', 'team-1', {fetchAll: true})
        .resolves({spaces: createMockSpaces(), total: 2})
      spaceService.getSpaces.withArgs('session-key', 'team-2', {fetchAll: true}).resolves({spaces: [], total: 0})
      projectConfigStore.write.resolves()
      cogitPullService.pull.resolves(createMockSnapshot())
      contextTreeMerger.merge.resolves({
        added: ['deleted.md'],
        conflicted: [],
        deleted: [],
        edited: [],
        restoredFromRemote: ['deleted.md'],
      })
      contextTreeSnapshotService.saveSnapshotFromState.resolves()

      const result = await callSwitchHandler({spaceId: 'space-2'})

      expect(result.success).to.be.true
      expect(result.pullResult).to.deep.include({restoredFromRemote: 1})

      const restoreBroadcast = broadcastToProject.getCalls().find((call: {args: unknown[]}) => {
        const data = call.args[2] as undefined | {message?: string}
        return call.args[1] === PullEvents.PROGRESS && data?.message?.includes('deleted')
      })
      expect(restoreBroadcast, 'restore message should be broadcast').to.exist
    })

    it('should not set restoredFromRemote in pullResult when merger returns none', async () => {
      createHandler()
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves(createLocalOnlyConfig())
      contextTreeSnapshotService.getChanges.resolves(withChanges())
      teamService.getTeams.resolves({teams: createMockTeams(), total: 2})
      spaceService.getSpaces
        .withArgs('session-key', 'team-1', {fetchAll: true})
        .resolves({spaces: createMockSpaces(), total: 2})
      spaceService.getSpaces.withArgs('session-key', 'team-2', {fetchAll: true}).resolves({spaces: [], total: 0})
      projectConfigStore.write.resolves()
      cogitPullService.pull.resolves(createMockSnapshot())
      contextTreeMerger.merge.resolves({
        added: [],
        conflicted: [],
        deleted: [],
        edited: [],
        restoredFromRemote: [],
      })
      contextTreeSnapshotService.saveSnapshotFromState.resolves()

      const result = await callSwitchHandler({spaceId: 'space-2'})

      expect(result.success).to.be.true
      expect(result.pullResult).to.not.have.property('restoredFromRemote')
    })

    // ==================== Same-space no-op ====================

    it('should return success immediately without any API calls when switching to the current space', async () => {
      createHandler()
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves(createMockConfig()) // spaceId: 'space-1'

      const result = await callSwitchHandler({spaceId: 'space-1'})

      expect(result.success).to.be.true
      expect(result.config).to.deep.include({spaceId: 'space-1', spaceName: 'frontend-app'})
      expect(result.pullResult).to.be.undefined
      // No teams/spaces fetch, no pull, no sync, no config write
      expect(teamService.getTeams.called).to.be.false
      expect(cogitPullService.pull.called).to.be.false
      expect(contextTreeWriterService.sync.called).to.be.false
      expect(projectConfigStore.write.called).to.be.false
    })

    it('should not throw LocalChangesExistError when switching to the current space with local changes', async () => {
      createHandler()
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves(createMockConfig()) // spaceId: 'space-1'

      // Same space — early return happens BEFORE getChanges is called
      const result = await callSwitchHandler({spaceId: 'space-1'})

      expect(result.success).to.be.true
      expect(contextTreeSnapshotService.getChanges.called).to.be.false
    })
  })

  describe('git vc guard', () => {
    it('should allow list when git vc is active', async () => {
      contextTreeService.hasGitRepo.resolves(true)
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves(createMockConfig())
      teamService.getTeams.resolves({teams: createMockTeams(), total: 2})
      spaceService.getSpaces.resolves({spaces: createMockSpaces(), total: 2})
      createHandler()

      const result = await callListHandler()
      expect(result.teams).to.exist
    })

    it('should throw GitVcInitializedError on switch when .git exists', async () => {
      contextTreeService.hasGitRepo.resolves(true)
      createHandler()

      try {
        await callSwitchHandler({spaceId: 'space-2'})
        expect.fail('should have thrown')
      } catch (error) {
        expect(error).to.be.instanceOf(GitVcInitializedError)
      }
    })

    it('should proceed normally on list when .git does not exist', async () => {
      contextTreeService.hasGitRepo.resolves(false)
      tokenStore.load.resolves(createMockToken())
      projectConfigStore.read.resolves(createMockConfig())
      teamService.getTeams.resolves({teams: createMockTeams(), total: 2})
      spaceService.getSpaces.resolves({spaces: createMockSpaces(), total: 2})
      createHandler()

      const result = await callListHandler()
      expect(result.teams).to.exist
    })
  })

  describe('space_switched analytics emits', () => {
    let analyticsClient: IAnalyticsClient & {trackSpy: ReturnType<typeof stub>}

    function makeFakeAnalyticsClient(): IAnalyticsClient & {trackSpy: ReturnType<typeof stub>} {
      const trackSpy = stub()
      return {
        abort: stub(),
        flush: stub().resolves({events: []}),
        getRuntimeState: stub().resolves({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
        onAuthTransition: stub().resolves(),
        track: trackSpy,
        trackSpy,
      } as unknown as IAnalyticsClient & {trackSpy: ReturnType<typeof stub>}
    }

    function createHandlerWithAnalytics(): void {
      const handler = new SpaceHandler({
        analyticsClient,
        broadcastToProject,
        cogitPullService,
        contextTreeMerger,
        contextTreeService: contextTreeService as unknown as IContextTreeService,
        contextTreeSnapshotService,
        contextTreeWriterService,
        projectConfigStore,
        resolveProjectPath,
        spaceService,
        teamService,
        tokenStore,
        transport,
      })
      handler.setup()
    }

    function emitsOf(name: string): Array<{args: unknown[]}> {
      return analyticsClient.trackSpy.getCalls().filter((c: {args: unknown[]}) => c.args[0] === name)
    }

    beforeEach(() => {
      analyticsClient = makeFakeAnalyticsClient()
    })

    it('emits space_switched outcome=success on switch to a different space', async () => {
      setupSwitchMocks()
      createHandlerWithAnalytics()

      await callSwitchHandler({spaceId: 'space-2'})

      const calls = emitsOf(AnalyticsEventNames.SPACE_SWITCHED)
      expect(calls.length).to.equal(1)
      const props = calls[0].args[1] as {from_space_id: string; outcome: string; to_space_id?: string}
      expect(props.outcome).to.equal('success')
      expect(props.from_space_id).to.equal('space-1')
      expect(props.to_space_id).to.equal('space-2')
    })

    it('emits space_switched outcome=success on no-op (same space) when existing space is set', async () => {
      setupSwitchMocks()
      createHandlerWithAnalytics()

      await callSwitchHandler({spaceId: 'space-1'})

      const calls = emitsOf(AnalyticsEventNames.SPACE_SWITCHED)
      expect(calls.length).to.equal(1)
      const props = calls[0].args[1] as {from_space_id: string; to_space_id?: string}
      expect(props.from_space_id).to.equal('space-1')
      expect(props.to_space_id).to.equal('space-1')
    })

    it('does NOT emit space_switched on first-time connect (no existing space)', async () => {
      setupSwitchMocks(createLocalOnlyConfig())
      createHandlerWithAnalytics()

      await callSwitchHandler({spaceId: 'space-2'})

      const calls = emitsOf(AnalyticsEventNames.SPACE_SWITCHED)
      expect(calls.length).to.equal(0)
    })

    it('emits space_switched outcome=failure when pull throws', async () => {
      setupSwitchMocks()
      cogitPullService.pull.rejects(new Error('network down'))
      createHandlerWithAnalytics()

      await callSwitchHandler({spaceId: 'space-2'})

      const calls = emitsOf(AnalyticsEventNames.SPACE_SWITCHED)
      expect(calls.length).to.equal(1)
      const props = calls[0].args[1] as {failure_kind?: string; from_space_id: string; outcome: string}
      expect(props.outcome).to.equal('failure')
      expect(props.failure_kind).to.equal('pull_failed')
      expect(props.from_space_id).to.equal('space-1')
    })
  })
})

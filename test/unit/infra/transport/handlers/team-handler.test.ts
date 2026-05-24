import {expect} from 'chai'
import {createSandbox, type SinonSandbox} from 'sinon'

import type {ITeamService} from '../../../../../src/server/core/interfaces/services/i-team-service.js'

import {Team} from '../../../../../src/server/core/domain/entities/team.js'
import {TeamHandler} from '../../../../../src/server/infra/transport/handlers/team-handler.js'
import {TeamEvents} from '../../../../../src/shared/transport/events/team-events.js'
import {createMockAuthStateStore, createMockTransportServer} from '../../../../helpers/mock-factories.js'

const teamFixture = (
  overrides: Partial<{
    avatarUrl: string
    displayName: string
    id: string
    isDefault: boolean
    name: string
    slug: string
  }> = {},
) =>
  new Team({
    avatarUrl: '',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    description: '',
    displayName: 'Acme Corp',
    id: 'team-1',
    isActive: true,
    isDefault: true,
    name: 'acme',
    slug: 'acme',
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  })

describe('TeamHandler', () => {
  let sandbox: SinonSandbox
  let transport: ReturnType<typeof createMockTransportServer>
  let teamService: ITeamService
  let getTeamsStub: ReturnType<SinonSandbox['stub']>

  beforeEach(() => {
    sandbox = createSandbox()
    transport = createMockTransportServer()
    getTeamsStub = sandbox.stub()
    teamService = {getTeams: getTeamsStub as ITeamService['getTeams']}
  })

  afterEach(() => {
    sandbox.restore()
  })

  function createHandler(options?: {isAuthenticated?: boolean}): TeamHandler {
    const handler = new TeamHandler({
      authStateStore: createMockAuthStateStore(sandbox, options),
      teamService,
      transport,
    })
    handler.setup()
    return handler
  }

  it('registers the team:list event handler on setup', () => {
    createHandler()
    expect(transport._handlers.has(TeamEvents.LIST)).to.equal(true)
  })

  it("returns the user's teams as DTOs when authenticated", async () => {
    getTeamsStub.resolves({
      teams: [
        teamFixture({
          avatarUrl: 'https://cdn.example.com/acme.png',
          displayName: 'Acme Corp',
          id: 'team-1',
          isDefault: true,
          name: 'acme',
          slug: 'acme-corp',
        }),
        teamFixture({
          avatarUrl: '',
          displayName: 'Personal',
          id: 'team-2',
          isDefault: false,
          name: 'personal',
          slug: 'personal',
        }),
      ],
      total: 2,
    })
    createHandler()

    const handler = transport._handlers.get(TeamEvents.LIST)
    const result = await handler!(undefined, 'client-1')

    expect(getTeamsStub.calledOnceWith('session', {fetchAll: true})).to.equal(true)
    expect(result).to.deep.equal({
      teams: [
        {
          avatarUrl: 'https://cdn.example.com/acme.png',
          displayName: 'Acme Corp',
          id: 'team-1',
          isDefault: true,
          name: 'acme',
          slug: 'acme-corp',
        },
        {
          avatarUrl: '',
          displayName: 'Personal',
          id: 'team-2',
          isDefault: false,
          name: 'personal',
          slug: 'personal',
        },
      ],
    })
  })

  it('returns an error envelope when not authenticated', async () => {
    createHandler({isAuthenticated: false})

    const handler = transport._handlers.get(TeamEvents.LIST)
    const result = await handler!(undefined, 'client-1')

    expect(getTeamsStub.called).to.equal(false)
    expect(result).to.have.property('error').that.matches(/sign in|authent/i)
    expect(result).to.not.have.property('teams')
  })

  it('returns an error envelope when the team service throws', async () => {
    getTeamsStub.rejects(new Error('upstream down'))
    createHandler()

    const handler = transport._handlers.get(TeamEvents.LIST)
    const result = await handler!(undefined, 'client-1')

    expect(result).to.have.property('error').that.equals('upstream down')
    expect(result).to.not.have.property('teams')
  })
})

import {expect} from 'chai'

import type {TeamDTO} from '../../../../../../src/shared/transport/types/dto'

import {computeTeamPreselection} from '../../../../../../src/webui/features/provider/utils/compute-team-preselection'

function makeTeam(id: string): TeamDTO {
  return {avatarUrl: '', displayName: id, id, isDefault: false, name: id, slug: id}
}

describe('computeTeamPreselection', () => {
  describe('valid pin wins', () => {
    it('returns the pinned team when it exists in the team list', () => {
      const result = computeTeamPreselection({
        paidOrganizationIds: ['A', 'B'],
        pinnedTeamId: 'A',
        teams: [makeTeam('A'), makeTeam('B')],
      })
      expect(result).to.equal('A')
    })

    it('returns the pinned team even when it is on the free tier (user can re-pick)', () => {
      const result = computeTeamPreselection({
        paidOrganizationIds: ['A'],
        pinnedTeamId: 'C',
        teams: [makeTeam('A'), makeTeam('C')],
      })
      expect(result).to.equal('C')
    })
  })

  describe('stale pin → fall through', () => {
    it('returns undefined when pin is not in the current team list and no auto-pick applies', () => {
      const result = computeTeamPreselection({
        paidOrganizationIds: ['A', 'B'],
        pinnedTeamId: 'stale-id',
        teams: [makeTeam('A'), makeTeam('B')],
      })
      expect(result).to.equal(undefined)
    })

    it('falls through to single-paid auto-pick when pin is stale', () => {
      const result = computeTeamPreselection({
        paidOrganizationIds: ['only'],
        pinnedTeamId: 'stale-id',
        teams: [makeTeam('only')],
      })
      expect(result).to.equal('only')
    })
  })

  describe('no pin', () => {
    it('returns undefined when there are no paid teams', () => {
      const result = computeTeamPreselection({
        paidOrganizationIds: [],
        teams: [makeTeam('free-A')],
      })
      expect(result).to.equal(undefined)
    })

    it('returns the single paid team when there is exactly one paid team', () => {
      const result = computeTeamPreselection({
        paidOrganizationIds: ['only'],
        teams: [makeTeam('only')],
      })
      expect(result).to.equal('only')
    })

    it('returns the workspace team when there are multiple paid teams and workspace is paid', () => {
      const result = computeTeamPreselection({
        paidOrganizationIds: ['A', 'B'],
        teams: [makeTeam('A'), makeTeam('B')],
        workspaceTeamId: 'A',
      })
      expect(result).to.equal('A')
    })

    it('returns the workspace team even when workspace is on the free tier', () => {
      const result = computeTeamPreselection({
        paidOrganizationIds: ['A', 'B'],
        teams: [makeTeam('A'), makeTeam('B'), makeTeam('free-workspace')],
        workspaceTeamId: 'free-workspace',
      })
      expect(result).to.equal('free-workspace')
    })

    it('returns undefined when there are multiple paid teams and no workspace', () => {
      const result = computeTeamPreselection({
        paidOrganizationIds: ['A', 'B'],
        teams: [makeTeam('A'), makeTeam('B')],
      })
      expect(result).to.equal(undefined)
    })
  })
})

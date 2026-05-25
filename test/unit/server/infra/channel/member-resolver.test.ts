import {expect} from 'chai'

import type {ChannelMeta} from '../../../../../src/shared/types/channel.js'

import {ChannelMemberNotFoundError} from '../../../../../src/server/core/domain/channel/errors.js'
import {resolveMentions} from '../../../../../src/server/infra/channel/member-resolver.js'

// Slice 2.3 — pure function over ChannelMeta.members. Multi-mention aware;
// throws ChannelMemberNotFoundError with structured payload listing the
// unknown handles + the active known handles.

const baseMeta = (members: ChannelMeta['members']): ChannelMeta => ({
  channelId: 'pi-test',
  createdAt: '2026-05-11T00:00:00.000Z',
  members,
  updatedAt: '2026-05-11T00:00:00.000Z',
})

const acpMember = (handle: string, status: 'idle' | 'left' = 'idle'): ChannelMeta['members'][number] => ({
  acpVersion: '1',
  agentName: handle,
  capabilities: [],
  driverClass: 'C-prime',
  handle,
  invocation: {args: [], command: 'node', cwd: '/tmp'},
  joinedAt: '2026-05-11T00:00:01.000Z',
  memberKind: 'acp-agent',
  status,
})

describe('resolveMentions', () => {
  it('returns matched members in the same order as the input handles', () => {
    const meta = baseMeta([acpMember('@a'), acpMember('@b')])
    const result = resolveMentions(meta, ['@b', '@a'])
    expect(result.map((m) => m.handle)).to.deep.equal(['@b', '@a'])
  })

  it('throws ChannelMemberNotFoundError with unknown + known payload when a handle is missing', () => {
    const meta = baseMeta([acpMember('@a')])
    try {
      resolveMentions(meta, ['@a', '@ghost'])
      expect.fail('expected ChannelMemberNotFoundError')
    } catch (error) {
      expect(error).to.be.instanceOf(ChannelMemberNotFoundError)
      const details = (error as ChannelMemberNotFoundError).details as {
        knownHandles: string[]
        unknownHandles: string[]
      }
      expect(details.unknownHandles).to.deep.equal(['@ghost'])
      expect(details.knownHandles).to.deep.equal(['@a'])
    }
  })

  it('treats members with status === "left" as unknown', () => {
    const meta = baseMeta([acpMember('@a', 'left')])
    try {
      resolveMentions(meta, ['@a'])
      expect.fail('expected ChannelMemberNotFoundError')
    } catch (error) {
      expect(error).to.be.instanceOf(ChannelMemberNotFoundError)
    }
  })
})

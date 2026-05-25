import type {ChannelMember, ChannelMeta} from '../../../shared/types/channel.js'

import {ChannelMemberNotFoundError} from '../../core/domain/channel/errors.js'

/**
 * Resolve a list of mention handles against the channel's member roster
 * (Slice 2.3). Multi-mention aware; returns matched members in the same
 * order as the input handles.
 *
 *  - Members with `status === 'left'` are treated as unknown (channel
 *    members ledger is append-only; left members stay in the file but
 *    cannot receive new mentions).
 *  - Unknown handles → throws {@link ChannelMemberNotFoundError} with
 *    structured `details: { unknownHandles, knownHandles }` payload.
 */
export const resolveMentions = (meta: ChannelMeta, handles: string[]): ChannelMember[] => {
  const activeByHandle = new Map<string, ChannelMember>()
  for (const member of meta.members) {
    const {status} = (member as {status?: string})
    if (status === 'left') continue
    activeByHandle.set(member.handle, member)
  }

  const unknown: string[] = []
  const resolved: ChannelMember[] = []
  for (const handle of handles) {
    const match = activeByHandle.get(handle)
    if (match === undefined) {
      unknown.push(handle)
    } else {
      resolved.push(match)
    }
  }

  if (unknown.length > 0) {
    throw new ChannelMemberNotFoundError(unknown, [...activeByHandle.keys()])
  }

  return resolved
}

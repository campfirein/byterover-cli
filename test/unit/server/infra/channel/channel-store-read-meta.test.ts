import {expect} from 'chai'

import type {ChannelMeta} from '../../../../../src/shared/types/channel.js'

import {ChannelStore} from '../../../../../src/server/infra/channel/channel-store.js'
import {ChannelEventsWriter} from '../../../../../src/server/infra/channel/storage/events-writer.js'
import {ChannelSnapshotWriter} from '../../../../../src/server/infra/channel/storage/snapshot-writer.js'
import {ChannelTreeReader} from '../../../../../src/server/infra/channel/storage/tree-reader.js'
import {ChannelWriteSerializer} from '../../../../../src/server/infra/channel/storage/write-serializer.js'
import {makeTempContextTree} from '../../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../../helpers/temp-dir.js'

// Slice 2.0 — IChannelStore.readChannelMeta returns the FULL ChannelMeta
// (discriminated-union members with `invocation`, `capabilities`, etc.).
//
// Phase 1's readChannel() returns a Channel wire-projection which strips
// member invocation fields; the Phase-2 orchestrator needs the full meta
// to dispatch through ACP. The summarised projection stays available for
// `channel:get` responses.
describe('ChannelStore.readChannelMeta (Slice 2.0)', () => {
  let projectRoot: string
  let store: ChannelStore
  const channelId = 'pi-test'

  beforeEach(async () => {
    projectRoot = await makeTempContextTree()
    const serializer = new ChannelWriteSerializer()
    store = new ChannelStore({
      eventsWriter: new ChannelEventsWriter({serializer}),
      snapshotWriter: new ChannelSnapshotWriter({eventsWriter: new ChannelEventsWriter({serializer: new ChannelWriteSerializer()})}),
      treeReader: new ChannelTreeReader(),
      writeSerializer: serializer,
    })
  })

  afterEach(async () => {
    await removeTempDir(projectRoot)
  })

  const baseMeta = (): ChannelMeta => ({
    channelId,
    createdAt: '2026-05-11T00:00:00.000Z',
    members: [],
    updatedAt: '2026-05-11T00:00:00.000Z',
  })

  it('returns the persisted meta with full acp-agent invocation fields', async () => {
    const meta: ChannelMeta = {
      ...baseMeta(),
      members: [
        {
          acpVersion: '1',
          agentName: '@mock',
          capabilities: ['embeddedContext'],
          driverClass: 'C-prime',
          handle: '@mock',
          invocation: {args: ['mock-acp.js'], command: 'node', cwd: '/tmp'},
          joinedAt: '2026-05-11T00:00:01.000Z',
          memberKind: 'acp-agent',
          status: 'idle',
        },
      ],
    }
    await store.createChannel({meta, projectRoot})

    const got = await store.readChannelMeta({channelId, projectRoot})
    expect(got).to.not.equal(undefined)
    expect(got?.members).to.have.lengthOf(1)
    const member = got?.members[0]
    if (member?.memberKind !== 'acp-agent') {
      expect.fail('expected acp-agent member')
      return
    }

    expect(member.invocation.command).to.equal('node')
    expect(member.invocation.args).to.deep.equal(['mock-acp.js'])
    expect(member.invocation.cwd).to.equal('/tmp')
    expect(member.capabilities).to.deep.equal(['embeddedContext'])
    expect(member.driverClass).to.equal('C-prime')
    expect(member.acpVersion).to.equal('1')
  })

  it('returns undefined when the channel does not exist', async () => {
    const got = await store.readChannelMeta({channelId: 'missing', projectRoot})
    expect(got).to.equal(undefined)
  })

  it('does not affect the wire-projection readChannel() shape', async () => {
    await store.createChannel({meta: baseMeta(), projectRoot})
    const wire = await store.readChannel({channelId, projectRoot})
    expect(wire).to.not.equal(undefined)
    // The wire Channel does not expose `members[].invocation`; this is what
    // makes readChannelMeta necessary in the first place.
    expect((wire as unknown as {members: unknown[]}).members).to.deep.equal([])
  })
})

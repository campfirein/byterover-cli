import {expect} from 'chai'
import {join} from 'node:path'

import {channelPaths} from '../../../../../../src/server/infra/channel/storage/paths.js'

// Slice 1.3 — canonical disk layout per CHANNEL_PROTOCOL.md §4.2.
// Pure path-construction helpers; no IO. Every consumer (events-writer,
// snapshot-writer, tree-reader) builds its filesystem paths through these
// helpers so the on-disk shape stays defined in exactly one place.
describe('channelPaths', () => {
  const projectRoot = '/abs/proj'

  it('roots channels under <project>/.brv/context-tree/channel/', () => {
    expect(channelPaths.channelsRoot(projectRoot)).to.equal(
      join('/abs/proj', '.brv', 'context-tree', 'channel'),
    )
  })

  it('roots a single channel under <project>/.brv/context-tree/channel/<id>/', () => {
    expect(channelPaths.channelDir(projectRoot, 'pi-test')).to.equal(
      join('/abs/proj', '.brv', 'context-tree', 'channel', 'pi-test'),
    )
  })

  it('puts meta.json directly under the channel directory', () => {
    expect(channelPaths.metaFile(projectRoot, 'pi-test')).to.equal(
      join('/abs/proj', '.brv', 'context-tree', 'channel', 'pi-test', 'meta.json'),
    )
  })

  it('groups turn artifacts under turns/<turnId>/', () => {
    expect(channelPaths.turnDir(projectRoot, 'pi-test', '01HX')).to.equal(
      join('/abs/proj', '.brv', 'context-tree', 'channel', 'pi-test', 'turns', '01HX'),
    )
  })

  it('puts events.jsonl directly under the turn directory', () => {
    expect(channelPaths.eventsFile(projectRoot, 'pi-test', '01HX')).to.equal(
      join('/abs/proj', '.brv', 'context-tree', 'channel', 'pi-test', 'turns', '01HX', 'events.jsonl'),
    )
  })

  it('puts the per-turn snapshot at turn.json under the turn directory', () => {
    expect(channelPaths.turnSnapshotFile(projectRoot, 'pi-test', '01HX')).to.equal(
      join('/abs/proj', '.brv', 'context-tree', 'channel', 'pi-test', 'turns', '01HX', 'turn.json'),
    )
  })

  it('puts per-delivery snapshots under deliveries/<deliveryId>.json', () => {
    expect(channelPaths.deliverySnapshotFile(projectRoot, 'pi-test', '01HX', 'd-1')).to.equal(
      join('/abs/proj', '.brv', 'context-tree', 'channel', 'pi-test', 'turns', '01HX', 'deliveries', 'd-1.json'),
    )
  })

  it('puts rendered messages under messages/<deliveryId>.md', () => {
    expect(channelPaths.messageFile(projectRoot, 'pi-test', '01HX', 'd-1')).to.equal(
      join('/abs/proj', '.brv', 'context-tree', 'channel', 'pi-test', 'turns', '01HX', 'messages', 'd-1.md'),
    )
  })

  it('puts artifacts under artifacts/ (sibling of turns/)', () => {
    expect(channelPaths.artifactsDir(projectRoot, 'pi-test')).to.equal(
      join('/abs/proj', '.brv', 'context-tree', 'channel', 'pi-test', 'artifacts'),
    )
  })

  it('puts invitations under invitations/<invitationId>.json', () => {
    expect(channelPaths.invitationFile(projectRoot, 'pi-test', 'inv-1')).to.equal(
      join('/abs/proj', '.brv', 'context-tree', 'channel', 'pi-test', 'invitations', 'inv-1.json'),
    )
  })

  // Slice 9.1 — channel transcripts move OUT of .brv/context-tree/ to a
  // sibling mount .brv/channel-history/. The new mount is per-project,
  // outside the cogit-synced tree, and consolidates the previous
  // events.jsonl + turn.json + deliveries/*.json + messages/*.md into a
  // single NDJSON-per-turn at turns/<turnId>.ndjson. Index lives at the
  // per-channel root. Both reviewers (codex + kimi) signed off on this
  // layout. Path helpers are pure (no IO).
  describe('Slice 9.1 — channel history mount', () => {
    it('roots channel history under <project>/.brv/channel-history/', () => {
      expect(channelPaths.channelHistoryRoot(projectRoot)).to.equal(
        join('/abs/proj', '.brv', 'channel-history'),
      )
    })

    it('roots a single channel history under <project>/.brv/channel-history/<id>/', () => {
      expect(channelPaths.channelHistoryDir(projectRoot, 'pi-test')).to.equal(
        join('/abs/proj', '.brv', 'channel-history', 'pi-test'),
      )
    })

    it('puts the per-turn NDJSON at turns/<turnId>.ndjson under the channel history dir', () => {
      expect(channelPaths.turnNdjsonFile(projectRoot, 'pi-test', '01HX')).to.equal(
        join('/abs/proj', '.brv', 'channel-history', 'pi-test', 'turns', '01HX.ndjson'),
      )
    })

    it('puts the per-channel index.jsonl directly under the channel history dir', () => {
      expect(channelPaths.indexJsonlFile(projectRoot, 'pi-test')).to.equal(
        join('/abs/proj', '.brv', 'channel-history', 'pi-test', 'index.jsonl'),
      )
    })

    it('puts the per-channel turns directory at turns/ under the channel history dir', () => {
      expect(channelPaths.historyTurnsDir(projectRoot, 'pi-test')).to.equal(
        join('/abs/proj', '.brv', 'channel-history', 'pi-test', 'turns'),
      )
    })

    it('keeps the channel history mount outside .brv/context-tree/', () => {
      // Regression guard against accidental re-nesting under context-tree.
      // If this string ever appears in the history path, cogit will start
      // syncing transcripts again and the whole phase regresses.
      expect(channelPaths.channelHistoryRoot(projectRoot)).to.not.match(/context-tree/)
      expect(channelPaths.turnNdjsonFile(projectRoot, 'pi-test', '01HX')).to.not.match(/context-tree/)
    })
  })
})

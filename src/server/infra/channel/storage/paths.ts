import {join} from 'node:path'

/**
 * Canonical channel-protocol on-disk layout per CHANNEL_PROTOCOL.md §4.2
 * and §11 (Phase 9 transcript-storage migration).
 *
 *   # Curated channel state (cogit-synced)
 *   <projectRoot>/.brv/context-tree/channel/<channelId>/
 *     meta.json                          (mutable; atomic rename writes)
 *     artifacts/<artifactId>             (files agents produced)
 *     invitations/<invitationId>.json    (pending invites)
 *
 *   # Ephemeral transcripts (NOT cogit-synced; retentioned in Phase 9)
 *   <projectRoot>/.brv/channel-history/<channelId>/
 *     index.jsonl                        (per-turn metadata index — Slice 9.3)
 *     turns/<turnId>.ndjson              (single file per turn: events
 *                                         interleaved with snapshot/delivery/
 *                                         message lines tagged via
 *                                         _recordType envelope)
 *
 *   # Legacy transcript layout (read-only fallback during Phase 9 migration)
 *   <projectRoot>/.brv/context-tree/channel/<channelId>/turns/<turnId>/
 *     events.jsonl                       (append-only event log)
 *     turn.json                          (snapshot at terminal state)
 *     deliveries/<deliveryId>.json
 *     messages/<deliveryId>.md
 *
 * Every storage consumer (events-writer, snapshot-writer, tree-reader) builds
 * its filesystem paths through these helpers so the layout is defined exactly
 * once. Pure path-construction; no IO.
 */

const CHANNEL_TREE_SEGMENTS = ['.brv', 'context-tree', 'channel'] as const
const CHANNEL_HISTORY_SEGMENTS = ['.brv', 'channel-history'] as const

export const channelPaths = {
  artifactsDir: (projectRoot: string, channelId: string): string =>
    join(projectRoot, ...CHANNEL_TREE_SEGMENTS, channelId, 'artifacts'),

  channelDir: (projectRoot: string, channelId: string): string =>
    join(projectRoot, ...CHANNEL_TREE_SEGMENTS, channelId),

  channelHistoryDir: (projectRoot: string, channelId: string): string =>
    join(projectRoot, ...CHANNEL_HISTORY_SEGMENTS, channelId),

  channelHistoryRoot: (projectRoot: string): string =>
    join(projectRoot, ...CHANNEL_HISTORY_SEGMENTS),

  channelsRoot: (projectRoot: string): string => join(projectRoot, ...CHANNEL_TREE_SEGMENTS),

  deliverySnapshotFile: (
    projectRoot: string,
    channelId: string,
    turnId: string,
    deliveryId: string,
  ): string =>
    join(
      projectRoot,
      ...CHANNEL_TREE_SEGMENTS,
      channelId,
      'turns',
      turnId,
      'deliveries',
      `${deliveryId}.json`,
    ),

  eventsFile: (projectRoot: string, channelId: string, turnId: string): string =>
    join(projectRoot, ...CHANNEL_TREE_SEGMENTS, channelId, 'turns', turnId, 'events.jsonl'),

  historyTurnsDir: (projectRoot: string, channelId: string): string =>
    join(projectRoot, ...CHANNEL_HISTORY_SEGMENTS, channelId, 'turns'),

  indexJsonlFile: (projectRoot: string, channelId: string): string =>
    join(projectRoot, ...CHANNEL_HISTORY_SEGMENTS, channelId, 'index.jsonl'),

  invitationFile: (projectRoot: string, channelId: string, invitationId: string): string =>
    join(projectRoot, ...CHANNEL_TREE_SEGMENTS, channelId, 'invitations', `${invitationId}.json`),

  messageFile: (
    projectRoot: string,
    channelId: string,
    turnId: string,
    deliveryId: string,
  ): string =>
    join(
      projectRoot,
      ...CHANNEL_TREE_SEGMENTS,
      channelId,
      'turns',
      turnId,
      'messages',
      `${deliveryId}.md`,
    ),

  metaFile: (projectRoot: string, channelId: string): string =>
    join(projectRoot, ...CHANNEL_TREE_SEGMENTS, channelId, 'meta.json'),

  // Phase 10 Slice 10.7 — persistent quorum store. One NDJSON file per
  // dispatchId, append-only. Each line is a snapshot of the MergedQuorum
  // shape at write time; the latest record wins on read. Live backfill
  // (Slice 10.7 Phase B) will append additional records as late-arriving
  // findings merge in.
  quorumDir: (projectRoot: string, channelId: string): string =>
    join(projectRoot, ...CHANNEL_HISTORY_SEGMENTS, channelId, 'quorum'),

  quorumFile: (projectRoot: string, channelId: string, dispatchId: string): string =>
    join(projectRoot, ...CHANNEL_HISTORY_SEGMENTS, channelId, 'quorum', `${dispatchId}.ndjson`),

  turnDir: (projectRoot: string, channelId: string, turnId: string): string =>
    join(projectRoot, ...CHANNEL_TREE_SEGMENTS, channelId, 'turns', turnId),

  turnNdjsonFile: (projectRoot: string, channelId: string, turnId: string): string =>
    join(projectRoot, ...CHANNEL_HISTORY_SEGMENTS, channelId, 'turns', `${turnId}.ndjson`),

  turnSnapshotFile: (projectRoot: string, channelId: string, turnId: string): string =>
    join(projectRoot, ...CHANNEL_TREE_SEGMENTS, channelId, 'turns', turnId, 'turn.json'),
} as const

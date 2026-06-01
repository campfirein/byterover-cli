import {join} from 'node:path'

import {BRV_DIR} from '../../../constants.js'

/**
 * Directory name (under a project's `.brv/`) that holds all channel state:
 * channel metadata plus the append-only per-turn NDJSON transcripts. Kept
 * separate from `context-tree/` so transcripts are never swept into the
 * cogit-synced knowledge tree.
 */
const CHANNEL_HISTORY_DIR = 'channel-history'

/** File name of a channel's metadata document. */
const META_FILE = 'meta.json'

/** Sub-directory (under a channel) that holds per-turn transcript files. */
const TURNS_DIR = 'turns'

/**
 * The on-disk layout for channel metadata and transcripts, defined exactly
 * once. Every store derives its paths from here so the storage location is a
 * single point of change. All helpers are pure functions of `projectRoot` so a
 * channel's state is co-located with the project it belongs to.
 */
export const channelPaths = {
  /** Returns a channel's directory: `<projectRoot>/.brv/channel-history/<channelId>`. */
  channelDir: (projectRoot: string, channelId: string): string =>
    join(projectRoot, BRV_DIR, CHANNEL_HISTORY_DIR, channelId),

  /** Returns the per-project channel-history root: `<projectRoot>/.brv/channel-history`. */
  channelHistoryRoot: (projectRoot: string): string => join(projectRoot, BRV_DIR, CHANNEL_HISTORY_DIR),

  /** Returns a channel's metadata file: `.../<channelId>/meta.json`. */
  metaFile: (projectRoot: string, channelId: string): string =>
    join(projectRoot, BRV_DIR, CHANNEL_HISTORY_DIR, channelId, META_FILE),

  /** Returns a turn's NDJSON transcript file: `.../<channelId>/turns/<turnId>.ndjson`. */
  turnNdjsonFile: (projectRoot: string, channelId: string, turnId: string): string =>
    join(projectRoot, BRV_DIR, CHANNEL_HISTORY_DIR, channelId, TURNS_DIR, `${turnId}.ndjson`),

  /** Returns a channel's turns directory: `.../<channelId>/turns`. */
  turnsDir: (projectRoot: string, channelId: string): string =>
    join(projectRoot, BRV_DIR, CHANNEL_HISTORY_DIR, channelId, TURNS_DIR),
}

import {promises as fs} from 'node:fs'
import {join} from 'node:path'

import {makeTempDir} from './temp-dir.js'

/**
 * Creates a scratch project directory with a minimal `.brv/context-tree/`
 * layout, suitable as the `projectDir` for {@link ChannelTestHarness.boot}.
 *
 * The directory is rooted under the OS temp area. Caller is responsible for
 * cleanup via {@link removeTempDir} from `temp-dir.js`.
 */
export const makeTempContextTree = async (): Promise<string> => {
  const projectDir = await makeTempDir('brv-channel-project-')
  // Mirrors CHANNEL_PROTOCOL.md §4.2 storage layout root. Subdirectories
  // (channel/<id>/turns/, artifacts/, invitations/) are created lazily by
  // the orchestrator when the first channel is created.
  await fs.mkdir(join(projectDir, '.brv', 'context-tree'), {recursive: true})
  return projectDir
}

import {expect} from 'chai'
import {join} from 'node:path'

import {channelPaths} from '../../../../../../src/server/infra/channel/storage/channel-paths.js'

describe('channelPaths', () => {
  const projectRoot = '/tmp/proj'

  it('channelHistoryRoot is <projectRoot>/.brv/channel-history', () => {
    expect(channelPaths.channelHistoryRoot(projectRoot)).to.equal(
      join('/tmp/proj', '.brv', 'channel-history'),
    )
  })

  it('channelDir nests the channelId under channel-history', () => {
    expect(channelPaths.channelDir(projectRoot, 'ch1')).to.equal(
      join('/tmp/proj', '.brv', 'channel-history', 'ch1'),
    )
  })

  it('metaFile is <channelDir>/meta.json', () => {
    expect(channelPaths.metaFile(projectRoot, 'ch1')).to.equal(
      join('/tmp/proj', '.brv', 'channel-history', 'ch1', 'meta.json'),
    )
  })

  it('turnsDir is <channelDir>/turns', () => {
    expect(channelPaths.turnsDir(projectRoot, 'ch1')).to.equal(
      join('/tmp/proj', '.brv', 'channel-history', 'ch1', 'turns'),
    )
  })

  it('turnNdjsonFile is <turnsDir>/<turnId>.ndjson', () => {
    expect(channelPaths.turnNdjsonFile(projectRoot, 'ch1', 't1')).to.equal(
      join('/tmp/proj', '.brv', 'channel-history', 'ch1', 'turns', 't1.ndjson'),
    )
  })

  it('keeps channel storage out of the cogit-synced context-tree', () => {
    const contextTree = join('.brv', 'context-tree')
    expect(channelPaths.turnNdjsonFile(projectRoot, 'ch1', 't1')).to.not.contain(contextTree)
    expect(channelPaths.metaFile(projectRoot, 'ch1')).to.not.contain(contextTree)
  })
})

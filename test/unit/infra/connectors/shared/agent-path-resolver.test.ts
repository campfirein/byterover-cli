import {expect} from 'chai'
import path from 'node:path'

import {
  resolveOpenClawDefaultWorkspaceDir,
  resolveOpenClawStateDir,
  resolveOpenClawUserPath,
} from '../../../../../src/server/infra/connectors/shared/agent-path-resolver.js'

const HOME = '/base/home'

describe('agent-path-resolver — OpenClaw faithfulness', () => {
  describe('resolveOpenClawUserPath', () => {
    it('leaves absolute paths unchanged (normalized)', () => {
      expect(resolveOpenClawUserPath('/abs/work space', {homeDir: HOME})).to.equal('/abs/work space')
    })

    it('resolves relative paths against cwd (path.resolve), NOT the home dir', () => {
      // OpenClaw resolves bare relative config with path.resolve(trimmed) (cwd-relative).
      expect(resolveOpenClawUserPath('rel/ws', {homeDir: HOME})).to.equal(path.resolve('rel/ws'))
    })

    it('expands ~ against OPENCLAW_HOME when set', () => {
      const out = resolveOpenClawUserPath('~/ws', {env: {OPENCLAW_HOME: '/oc/home'}, homeDir: HOME})
      expect(out).to.equal(path.resolve('/oc/home/ws'))
    })

    it('expands ~ against the base home when OPENCLAW_HOME is not set', () => {
      expect(resolveOpenClawUserPath('~/ws', {homeDir: HOME})).to.equal(path.resolve(`${HOME}/ws`))
    })
  })

  describe('resolveOpenClawDefaultWorkspaceDir', () => {
    it('honors OPENCLAW_HOME (workspace lives under $OPENCLAW_HOME/.openclaw/workspace)', () => {
      const out = resolveOpenClawDefaultWorkspaceDir({env: {OPENCLAW_HOME: '/oc/home'}, homeDir: HOME})
      expect(out).to.equal(path.join('/oc/home', '.openclaw', 'workspace'))
    })

    it('falls back to the base home dir when OPENCLAW_HOME is not set', () => {
      expect(resolveOpenClawDefaultWorkspaceDir({homeDir: HOME})).to.equal(
        path.join(HOME, '.openclaw', 'workspace'),
      )
    })

    it('applies the OPENCLAW_PROFILE suffix', () => {
      const out = resolveOpenClawDefaultWorkspaceDir({env: {OPENCLAW_PROFILE: 'work'}, homeDir: HOME})
      expect(out).to.equal(path.join(HOME, '.openclaw', 'workspace-work'))
    })
  })

  describe('resolveOpenClawStateDir', () => {
    it('honors OPENCLAW_HOME for the default state dir', () => {
      const out = resolveOpenClawStateDir({env: {OPENCLAW_HOME: '/oc/home'}, homeDir: HOME})
      expect(out).to.equal(path.join('/oc/home', '.openclaw'))
    })

    it('OPENCLAW_STATE_DIR override wins', () => {
      const out = resolveOpenClawStateDir({env: {OPENCLAW_STATE_DIR: '/explicit/state'}, homeDir: HOME})
      expect(out).to.equal('/explicit/state')
    })
  })
})

import {expect} from 'chai'
import {mkdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'

import type {Agent} from '../../../../../src/server/core/domain/entities/agent.js'
import type {ConnectorType} from '../../../../../src/server/core/domain/entities/connector-type.js'
import type {IRuleTemplateService} from '../../../../../src/server/core/interfaces/services/i-rule-template-service.js'

import {RulesConnector} from '../../../../../src/server/infra/connectors/rules/rules-connector.js'
import {BRV_RULE_MARKERS, BRV_RULE_TAG} from '../../../../../src/server/infra/connectors/shared/constants.js'
import {FsFileService} from '../../../../../src/server/infra/file/fs-file-service.js'

class StubTemplateService implements IRuleTemplateService {
  async generateRuleContent(_agent: Agent, _type?: ConnectorType): Promise<string> {
    throw new Error('StubTemplateService.generateRuleContent should not be called from status flow')
  }
}

const buildAgentsMd = (footerAgent?: Agent): string => {
  const footer = footerAgent === undefined ? '' : `\n---\n${BRV_RULE_TAG} ${footerAgent}`
  return `${BRV_RULE_MARKERS.START}\nrule body${footer}\n${BRV_RULE_MARKERS.END}\n`
}

describe('RulesConnector.status (shared AGENTS.md disambiguation)', () => {
  let testDir: string
  let connector: RulesConnector

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `rules-connector-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(testDir, {recursive: true})
    connector = new RulesConnector({
      fileService: new FsFileService(),
      projectRoot: testDir,
      templateService: new StubTemplateService(),
    })
  })

  afterEach(async () => {
    await rm(testDir, {force: true, recursive: true})
  })

  it('reports installed:true only for the agent named in the footer (Codex)', async () => {
    await writeFile(path.join(testDir, 'AGENTS.md'), buildAgentsMd('Codex'))

    const codex = await connector.status('Codex')
    const amp = await connector.status('Amp')
    const opencode = await connector.status('OpenCode')

    expect(codex.installed, 'Codex should be reported installed').to.equal(true)
    expect(amp.installed, 'Amp should NOT be reported installed for a Codex-authored AGENTS.md').to.equal(false)
    expect(opencode.installed, 'OpenCode should NOT be reported installed for a Codex-authored AGENTS.md').to.equal(false)
  })

  it('reports installed:true for the agent named in the footer (Amp)', async () => {
    await writeFile(path.join(testDir, 'AGENTS.md'), buildAgentsMd('Amp'))

    const codex = await connector.status('Codex')
    const amp = await connector.status('Amp')

    expect(amp.installed).to.equal(true)
    expect(codex.installed).to.equal(false)
  })

  it('falls back to the legacy behavior when the BRV section has no footer (markers => installed for all sharing agents)', async () => {
    await writeFile(path.join(testDir, 'AGENTS.md'), buildAgentsMd())

    const codex = await connector.status('Codex')
    const amp = await connector.status('Amp')
    const opencode = await connector.status('OpenCode')

    expect(codex.installed, 'legacy footer-less file should remain installed for Codex').to.equal(true)
    expect(amp.installed, 'legacy footer-less file should remain installed for Amp').to.equal(true)
    expect(opencode.installed, 'legacy footer-less file should remain installed for OpenCode').to.equal(true)
  })

  it('does not mistakenly mark Amp installed when only Claude Code (CLAUDE.md) was installed', async () => {
    await writeFile(path.join(testDir, 'CLAUDE.md'), buildAgentsMd('Claude Code'))

    const claudeCode = await connector.status('Claude Code')
    const amp = await connector.status('Amp')

    expect(claudeCode.installed).to.equal(true)
    expect(amp.installed).to.equal(false)
    expect(amp.configExists, 'Amp\'s AGENTS.md does not exist in this project').to.equal(false)
  })

  it('still reports installed:false when MCP tool markers are present (existing rule)', async () => {
    const content = `${BRV_RULE_MARKERS.START}\nuse the brv-query tool\n---\n${BRV_RULE_TAG} Codex\n${BRV_RULE_MARKERS.END}\n`
    await writeFile(path.join(testDir, 'AGENTS.md'), content)

    const codex = await connector.status('Codex')

    expect(codex.installed, 'a section that contains brv-query should not count as a rules install').to.equal(false)
  })
})

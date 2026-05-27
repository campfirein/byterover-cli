import {expect} from 'chai'
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'

import type {IRuleTemplateService} from '../../../../src/server/core/interfaces/services/i-rule-template-service.js'

import {ConnectorManager} from '../../../../src/server/infra/connectors/connector-manager.js'
import {BRV_RULE_MARKERS} from '../../../../src/server/infra/connectors/shared/constants.js'
import {BRV_SKILL_NAME} from '../../../../src/server/infra/connectors/skill/skill-connector-config.js'
import {FsFileService} from '../../../../src/server/infra/file/fs-file-service.js'

const createMockTemplateService = (): IRuleTemplateService => ({
  generateRuleContent: async () =>
    `${BRV_RULE_MARKERS.START}\nMock MCP rule content\n${BRV_RULE_MARKERS.END}`,
})

describe('ConnectorManager - autonomous attachment freshness (Hermes)', () => {
  let testDir: string
  let hermesHome: string
  let fileService: FsFileService
  let connectorManager: ConnectorManager
  let previousHermesHome: string | undefined

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `brv-mgr-attach-${Date.now()}`)
    hermesHome = path.join(testDir, 'hermes-home')
    await mkdir(testDir, {recursive: true})
    fileService = new FsFileService()
    connectorManager = new ConnectorManager({
      fileService,
      projectRoot: testDir,
      templateService: createMockTemplateService(),
    })
    previousHermesHome = process.env.HERMES_HOME
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(async () => {
    if (previousHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = previousHermesHome
    await rm(testDir, {force: true, recursive: true})
  })

  it('reports skill installed after a clean Hermes skill install', async () => {
    await connectorManager.switchConnector('Hermes', 'skill')

    expect(await connectorManager.getInstalledConnectorType('Hermes')).to.equal('skill')
  })

  it('does not report skill installed when the SOUL.md block is stale (so re-install can repair)', async () => {
    await connectorManager.switchConnector('Hermes', 'skill')
    const soulPath = path.join(hermesHome, 'SOUL.md')
    // SKILL.md stays in place; the managed block keeps valid markers but
    // carries outdated content (simulates an upgrade / hand-edit).
    await writeFile(soulPath, `${BRV_RULE_MARKERS.START}\nOUTDATED RULES\n${BRV_RULE_MARKERS.END}\n`, 'utf8')

    expect(await connectorManager.getInstalledConnectorType('Hermes')).to.equal(null)
  })

  it('a same-type re-install repairs the stale SOUL.md block', async () => {
    await connectorManager.switchConnector('Hermes', 'skill')
    const soulPath = path.join(hermesHome, 'SOUL.md')
    await writeFile(soulPath, `${BRV_RULE_MARKERS.START}\nOUTDATED RULES\n${BRV_RULE_MARKERS.END}\n`, 'utf8')

    await connectorManager.switchConnector('Hermes', 'skill')

    const soulContent = await readFile(soulPath, 'utf8')
    expect(soulContent).to.not.include('OUTDATED RULES')
    expect(soulContent).to.include('brv query')
    expect(await connectorManager.getInstalledConnectorType('Hermes')).to.equal('skill')
  })

  it('a same-type re-install restores missing managed skill reference files', async () => {
    await connectorManager.switchConnector('Hermes', 'skill')
    const queryGuidePath = path.join(hermesHome, 'skills', BRV_SKILL_NAME, 'query.md')
    await rm(queryGuidePath)

    expect(await connectorManager.getInstalledConnectorType('Hermes')).to.equal(null)

    await connectorManager.switchConnector('Hermes', 'skill')

    const queryGuideContent = await readFile(queryGuidePath, 'utf8')
    expect(queryGuideContent).to.include('brv query')
    expect(await connectorManager.getInstalledConnectorType('Hermes')).to.equal('skill')
  })
})

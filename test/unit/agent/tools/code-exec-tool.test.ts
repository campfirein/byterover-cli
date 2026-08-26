import {expect} from 'chai'

import type {ISandboxService} from '../../../../src/agent/core/interfaces/i-sandbox-service.js'

import {createCodeExecTool} from '../../../../src/agent/infra/tools/implementations/code-exec-tool.js'

describe('code_exec tool', () => {
  it('preserves curateResults when large stdout is redirected', async () => {
    const curateResults = [{
      applied: [{
        confidence: 'high',
        impact: 'high',
        needsReview: true,
        path: '/review-integrity.md',
        reason: 'A core decision changed',
        status: 'success',
        type: 'UPSERT',
      }],
    }]
    const sandboxService = {
      async executeCode() {
        return {
          curateResults,
          executionTime: 12,
          finalResult: undefined,
          locals: {},
          returnValue: undefined,
          stderr: '',
          stdout: 'x'.repeat(3000),
        }
      },
      setSandboxVariable() {},
    } as unknown as ISandboxService
    const tool = createCodeExecTool(sandboxService)

    const result = await tool.execute(
      {code: 'console.log("x")'},
      {commandType: 'curate', sessionId: 'curate-session'},
    ) as Record<string, unknown>

    expect(result.curateResults).to.deep.equal(curateResults)
    expect(result.stdout).to.match(/stored in variable/i)
  })

  it('preserves an own curateResults property for every defined value in small and silent results', async () => {
    const cases = [false, true].flatMap((silent) => (
      [null, false, 0, ''].map((curateResults) => ({curateResults, silent}))
    ))

    await Promise.all(cases.map(async ({curateResults, silent}) => {
        const sandboxService = {
          async executeCode() {
            return {
              curateResults,
              executionTime: 1,
              finalResult: undefined,
              locals: {},
              returnValue: undefined,
              stderr: '',
              stdout: 'small output',
            }
          },
        } as unknown as ISandboxService
        const tool = createCodeExecTool(sandboxService)

        const result = await tool.execute(
          {code: 'return 1', silent},
          {commandType: 'curate', sessionId: 'curate-session'},
        ) as Record<string, unknown>

        expect(Object.hasOwn(result, 'curateResults')).to.equal(true)
        expect(result.curateResults).to.equal(curateResults)
        expect(result.stdout).to.equal(silent ? '' : 'small output')
    }))
  })
})

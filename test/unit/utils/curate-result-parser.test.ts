import {expect} from 'chai'

import {
  CurateOperationSchema,
  CurateResultSchema,
  extractCurateOperationCapture,
  extractCurateOperations,
  extractCurateResultFromCodeExec,
} from '../../../src/server/utils/curate-result-parser.js'

describe('curate-result-parser', () => {
  // ==========================================================================
  // CurateOperationSchema
  // ==========================================================================

  describe('CurateOperationSchema', () => {
    it('should accept a valid operation', () => {
      const result = CurateOperationSchema.safeParse({
        path: '/topics/auth.md',
        status: 'success',
        type: 'ADD',
      })
      expect(result.success).to.be.true
    })

    it('should accept optional fields', () => {
      const result = CurateOperationSchema.safeParse({
        filePath: '/src/auth.ts',
        message: 'created new topic',
        path: '/topics/auth.md',
        status: 'success',
        type: 'UPSERT',
      })
      expect(result.success).to.be.true
    })

    it('should reject invalid type', () => {
      const result = CurateOperationSchema.safeParse({
        path: '/topics/auth.md',
        status: 'success',
        type: 'INVALID',
      })
      expect(result.success).to.be.false
    })

    it('should reject invalid status', () => {
      const result = CurateOperationSchema.safeParse({
        path: '/topics/auth.md',
        status: 'pending',
        type: 'ADD',
      })
      expect(result.success).to.be.false
    })

    it('should reject missing path', () => {
      const result = CurateOperationSchema.safeParse({
        status: 'success',
        type: 'ADD',
      })
      expect(result.success).to.be.false
    })
  })

  // ==========================================================================
  // CurateResultSchema
  // ==========================================================================

  describe('CurateResultSchema', () => {
    it('should accept empty object', () => {
      expect(CurateResultSchema.safeParse({}).success).to.be.true
    })

    it('should accept object with applied array', () => {
      const result = CurateResultSchema.safeParse({
        applied: [{path: '/a.md', status: 'success', type: 'ADD'}],
      })
      expect(result.success).to.be.true
    })

    it('should reject invalid operation in applied array', () => {
      const result = CurateResultSchema.safeParse({
        applied: [{path: '/a.md', status: 'success', type: 'BAD_TYPE'}],
      })
      expect(result.success).to.be.false
    })
  })

  // ==========================================================================
  // extractCurateResultFromCodeExec
  // ==========================================================================

  describe('extractCurateResultFromCodeExec', () => {
    it('should use curateResults accumulator strategy first (strategy 0)', () => {
      const result = extractCurateResultFromCodeExec({
        curateResults: [
          {applied: [{path: '/a.md', status: 'success', type: 'ADD'}]},
          {applied: [{path: '/b.md', status: 'success', type: 'UPDATE'}]},
        ],
        returnValue: {applied: [{path: '/ignored.md', status: 'success', type: 'DELETE'}]},
      })
      expect((result as {applied: unknown[]}).applied).to.have.lengthOf(2)
    })

    it('should merge multiple curateResults entries', () => {
      const result = extractCurateResultFromCodeExec({
        curateResults: [
          {applied: [{path: '/a.md', status: 'success', type: 'ADD'}]},
          {applied: [{path: '/b.md', status: 'failed', type: 'UPDATE'}]},
        ],
      })
      expect((result as {applied: unknown[]}).applied).to.have.lengthOf(2)
    })

    it('should fall through to returnValue when curateResults is empty', () => {
      const result = extractCurateResultFromCodeExec({
        curateResults: [],
        returnValue: {applied: [{path: '/a.md', status: 'success', type: 'ADD'}]},
      })
      expect((result as {applied: unknown[]}).applied).to.have.lengthOf(1)
    })

    it('should use returnValue strategy when no curateResults', () => {
      const result = extractCurateResultFromCodeExec({
        returnValue: {applied: [{path: '/a.md', status: 'success', type: 'ADD'}]},
        stdout: 'ignored',
      })
      expect((result as {applied: unknown[]}).applied).to.have.lengthOf(1)
    })

    it('should parse JSON stdout when no returnValue', () => {
      const payload = {applied: [{path: '/b.md', status: 'success', type: 'UPDATE'}]}
      const result = extractCurateResultFromCodeExec({
        stdout: JSON.stringify(payload),
      })
      expect((result as {applied: unknown[]}).applied).to.have.lengthOf(1)
    })

    it('should fall through to locals when stdout is non-JSON', () => {
      const result = extractCurateResultFromCodeExec({
        locals: {
          r: {applied: [{path: '/c.md', status: 'success', type: 'MERGE'}]},
        },
        stdout: 'some plain text',
      })
      expect((result as {applied: unknown[]}).applied).to.have.lengthOf(1)
    })

    it('should merge multiple curate calls from locals', () => {
      const result = extractCurateResultFromCodeExec({
        locals: {
          r1: {applied: [{path: '/a.md', status: 'success', type: 'ADD'}]},
          r2: {applied: [{path: '/b.md', status: 'failed', type: 'UPDATE'}]},
        },
      })
      expect((result as {applied: unknown[]}).applied).to.have.lengthOf(2)
    })

    it('should skip locals with empty applied array', () => {
      const result = extractCurateResultFromCodeExec({
        locals: {
          r1: {applied: []},
          r2: {applied: [{path: '/a.md', status: 'success', type: 'ADD'}]},
        },
      })
      expect((result as {applied: unknown[]}).applied).to.have.lengthOf(1)
    })

    it('should skip non-curate-shaped locals', () => {
      const result = extractCurateResultFromCodeExec({
        locals: {
          x: {data: 42, some: 'other'},
          y: 'not an object',
        },
      })
      expect(result).to.be.undefined
    })

    it('should return undefined when no locals', () => {
      const result = extractCurateResultFromCodeExec({})
      expect(result).to.be.undefined
    })

    it('should return returnValue even if null is not falsy check - null is skipped', () => {
      const result = extractCurateResultFromCodeExec({returnValue: null})
      expect(result).to.be.undefined
    })
  })

  // ==========================================================================
  // extractCurateOperations
  // ==========================================================================

  describe('extractCurateOperations', () => {
    const validOp = {path: '/topics/auth.md', status: 'success' as const, type: 'ADD' as const}
    const capturedOperation = {
      confidence: 'high' as const,
      impact: 'low' as const,
      needsReview: false,
      path: '/topics/auth.md',
      reason: 'Capture a stable authentication rule',
      status: 'success' as const,
      type: 'ADD' as const,
    }

    it('should extract operations from curate tool result', () => {
      const ops = extractCurateOperations({
        result: {applied: [validOp]},
        toolName: 'curate',
      })
      expect(ops).to.have.lengthOf(1)
      expect(ops[0]).to.have.property('path', '/topics/auth.md')
    })

    it('should extract operations from code_exec returnValue', () => {
      const ops = extractCurateOperations({
        result: {returnValue: {applied: [validOp]}},
        toolName: 'code_exec',
      })
      expect(ops).to.have.lengthOf(1)
    })

    it('should extract operations from code_exec locals', () => {
      const ops = extractCurateOperations({
        result: {locals: {r: {applied: [validOp]}}},
        toolName: 'code_exec',
      })
      expect(ops).to.have.lengthOf(1)
    })

    it('should return empty array for non-curate tool', () => {
      const ops = extractCurateOperations({
        result: {applied: [validOp]},
        toolName: 'read-file',
      })
      expect(ops).to.have.lengthOf(0)
    })

    it('should return empty array when result is not an object for code_exec', () => {
      const ops = extractCurateOperations({
        result: 'plain string result',
        toolName: 'code_exec',
      })
      expect(ops).to.have.lengthOf(0)
    })

    it('should apply filter predicate', () => {
      const ops = extractCurateOperations(
        {
          result: {
            applied: [
              {path: '/a.md', status: 'success', type: 'ADD'},
              {path: '/b.md', status: 'failed', type: 'UPDATE'},
            ],
          },
          toolName: 'curate',
        },
        (op) => op.status === 'success',
      )
      expect(ops).to.have.lengthOf(1)
      expect(ops[0].path).to.equal('/a.md')
    })

    it('should return empty array when curate result has no applied field', () => {
      const ops = extractCurateOperations({
        result: {summary: {added: 1}},
        toolName: 'curate',
      })
      expect(ops).to.have.lengthOf(0)
    })

    it('should extract direct curate operations from lifecycleResult when display output is truncated', () => {
      const ops = extractCurateOperations({
        lifecycleResult: {applied: [capturedOperation]},
        result: '{"applied":[{"path":"/topics/auth.md"... output truncated',
        toolName: 'curate',
      } as never)

      expect(ops).to.deep.equal([capturedOperation])
    })

    it('should extract only code_exec curateResults from lifecycleResult', () => {
      const ops = extractCurateOperations({
        lifecycleResult: {
          curateResults: [{applied: [capturedOperation]}],
        },
        result: 'truncated display output',
        toolName: 'code_exec',
      } as never)

      expect(ops).to.deep.equal([capturedOperation])
    })
  })

  describe('extractCurateOperationCapture integrity policy', () => {
    const capturedOperation = {
      confidence: 'high' as const,
      impact: 'low' as const,
      needsReview: false,
      path: '/topics/auth.md',
      reason: 'Capture a stable authentication rule',
      status: 'success' as const,
      type: 'ADD' as const,
    }

    it('verifies a complete low-impact non-delete operation', () => {
      const capture = extractCurateOperationCapture({lifecycleResult: {applied: [capturedOperation]}, toolName: 'curate'})
      expect(capture.reviewIntegrity).to.deep.equal({status: 'verified'})
      expect(capture.operations).to.deep.equal([capturedOperation])
    })

    it('verifies complete high-impact and delete operations that require review', () => {
      for (const operation of [
        {...capturedOperation, impact: 'high' as const, needsReview: true, type: 'UPSERT' as const},
        {...capturedOperation, needsReview: true, type: 'DELETE' as const},
      ]) {
        const capture = extractCurateOperationCapture({lifecycleResult: {applied: [operation]}, toolName: 'curate'})
        expect(capture.reviewIntegrity).to.deep.equal({status: 'verified'})
        expect(capture.operations).to.deep.equal([operation])
      }
    })

    it('marks missing native review-decision fields unresolved', () => {
      const missingImpact: Partial<typeof capturedOperation> = {...capturedOperation}
      delete missingImpact.impact
      const capture = extractCurateOperationCapture({lifecycleResult: {applied: [missingImpact]}, toolName: 'curate'})
      expect(capture.operations).to.deep.equal([])
      expect(capture.reviewIntegrity?.status).to.equal('unresolved')
    })

    it('marks successful high-impact and delete review contradictions unresolved', () => {
      for (const operation of [
        {...capturedOperation, impact: 'high' as const, needsReview: false, type: 'UPSERT' as const},
        {...capturedOperation, needsReview: false, type: 'DELETE' as const},
        {...capturedOperation, needsReview: true},
      ]) {
        const capture = extractCurateOperationCapture({lifecycleResult: {applied: [operation]}, toolName: 'curate'})
        expect(capture.operations).to.deep.equal([])
        expect(capture.reviewIntegrity?.status).to.equal('unresolved')
      }
    })
  })
})

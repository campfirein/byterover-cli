import {expect} from 'chai'

import {CurateMetaSchema} from '../../../src/shared/curate-meta.js'

describe('CurateMetaSchema', () => {
  it('accepts an empty object (all fields optional)', () => {
    const result = CurateMetaSchema.safeParse({})
    expect(result.success).to.equal(true)
  })

  it('accepts every documented field with valid values', () => {
    const result = CurateMetaSchema.safeParse({
      confidence: 'high',
      impact: 'high',
      previousSummary: 'Prior summary.',
      reason: 'Locks the JWT signing algorithm.',
      summary: 'JWT: RS256 over HS256.',
      type: 'ADD',
    })
    expect(result.success).to.equal(true)
  })

  it('accepts ADD / UPDATE / MERGE for type', () => {
    for (const type of ['ADD', 'UPDATE', 'MERGE'] as const) {
      const result = CurateMetaSchema.safeParse({type})
      expect(result.success, `expected ${type} to parse`).to.equal(true)
    }
  })

  it('rejects DELETE / UPSERT for type (CurateMeta is the agent-asserted subset)', () => {
    for (const type of ['DELETE', 'UPSERT']) {
      const result = CurateMetaSchema.safeParse({type})
      expect(result.success, `expected ${type} to be rejected`).to.equal(false)
    }
  })

  it('rejects invalid impact enum values', () => {
    const result = CurateMetaSchema.safeParse({impact: 'severe'})
    expect(result.success).to.equal(false)
  })

  it('rejects invalid confidence enum values', () => {
    const result = CurateMetaSchema.safeParse({confidence: 'maybe'})
    expect(result.success).to.equal(false)
  })

  it('rejects extra keys (.strict catches typos like `importance`)', () => {
    const result = CurateMetaSchema.safeParse({importance: 'high'})
    expect(result.success).to.equal(false)
  })

  it('rejects non-string reason', () => {
    const result = CurateMetaSchema.safeParse({reason: 42})
    expect(result.success).to.equal(false)
  })
})

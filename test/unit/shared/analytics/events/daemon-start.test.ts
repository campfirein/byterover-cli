 
import {expect} from 'chai'

import {DaemonStartSchema} from '../../../../../src/shared/analytics/events/daemon-start.js'

describe('DaemonStartSchema', () => {
  it('should accept an empty object', () => {
    const result = DaemonStartSchema.safeParse({})
    expect(result.success).to.equal(true)
  })

  it('should reject unknown fields (strict)', () => {
    const result = DaemonStartSchema.safeParse({extra: 'nope'})
    expect(result.success).to.equal(false)
  })

  it('should reject null', () => {
    const result = DaemonStartSchema.safeParse(null)
    expect(result.success).to.equal(false)
  })

  it('should reject non-object payloads', () => {
    expect(DaemonStartSchema.safeParse('hi').success).to.equal(false)
    expect(DaemonStartSchema.safeParse(42).success).to.equal(false)
    expect(DaemonStartSchema.safeParse([]).success).to.equal(false)
  })
})

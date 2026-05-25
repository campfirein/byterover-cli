import {expect} from 'chai'

import {rowActionKind} from '../../../../../../src/webui/features/tasks/utils/row-action-kind.js'

describe('rowActionKind', () => {
  it('returns "cancel" for created tasks (running)', () => {
    expect(rowActionKind('created')).to.equal('cancel')
  })

  it('returns "cancel" for started tasks (running)', () => {
    expect(rowActionKind('started')).to.equal('cancel')
  })

  it('returns "delete" for completed tasks (terminal)', () => {
    expect(rowActionKind('completed')).to.equal('delete')
  })

  it('returns "delete" for error tasks (terminal)', () => {
    expect(rowActionKind('error')).to.equal('delete')
  })

  it('returns "delete" for cancelled tasks (terminal)', () => {
    expect(rowActionKind('cancelled')).to.equal('delete')
  })
})

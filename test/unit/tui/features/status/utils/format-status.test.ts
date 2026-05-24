import {expect} from 'chai'

import type {StatusDTO} from '../../../../../../src/shared/transport/types/dto.js'

import {formatStatus} from '../../../../../../src/tui/features/status/utils/format-status.js'

function makeStatus(overrides: Partial<StatusDTO> = {}): StatusDTO {
  return {
    authStatus: 'logged_in',
    contextTreeStatus: 'no_changes',
    currentDirectory: '/test/project',
    userEmail: 'test@example.com',
    ...overrides,
  }
}

// Strip ANSI escape codes for assertion
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replaceAll(/\u001B\[\d+m/g, '')
}

describe('formatStatus – pending review display', () => {
  it('should display pending review count and URL when present', () => {
    const status = makeStatus({
      pendingReviewCount: 3,
      reviewUrl: 'http://localhost:54321/changes',
    })

    const output = stripAnsi(formatStatus(status))
    expect(output).to.include('Pending Reviews: 3 files need review')
    expect(output).to.include('http://localhost:54321/changes')
  })

  it('should use singular "file" for count of 1', () => {
    const status = makeStatus({
      pendingReviewCount: 1,
      reviewUrl: 'http://localhost:54321/changes',
    })

    const output = stripAnsi(formatStatus(status))
    expect(output).to.include('1 file need review')
  })

  it('should NOT display review info when pendingReviewCount is 0', () => {
    const status = makeStatus({pendingReviewCount: 0})

    const output = stripAnsi(formatStatus(status))
    expect(output).to.not.include('Pending Reviews')
  })

  it('should NOT display review info when pendingReviewCount is undefined', () => {
    const status = makeStatus()

    const output = stripAnsi(formatStatus(status))
    expect(output).to.not.include('Pending Reviews')
  })

  it('should display review count even without URL', () => {
    const status = makeStatus({pendingReviewCount: 2})

    const output = stripAnsi(formatStatus(status))
    expect(output).to.include('Pending Reviews: 2 files need review')
    expect(output).to.not.include('Review:')
  })
})

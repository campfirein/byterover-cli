import {expect} from 'chai'

import type {ContextTreeNodeDTO} from '../../../../../../src/shared/transport/events/index.js'

import {hasRootIndex} from '../../../../../../src/webui/features/context/utils/has-root-index.js'

function blob(path: string): ContextTreeNodeDTO {
  const segments = path.split('/').filter(Boolean)
  return {name: segments.at(-1) ?? '', path, type: 'blob'}
}

function tree(path: string, children: ContextTreeNodeDTO[] = []): ContextTreeNodeDTO {
  const segments = path.split('/').filter(Boolean)
  return {children, name: segments.at(-1) ?? '', path, type: 'tree'}
}

describe('hasRootIndex', () => {
  it('returns true when selectedPath is empty and root contains index.html as a blob', () => {
    const nodes: ContextTreeNodeDTO[] = [blob('index.html'), blob('architecture.md')]
    expect(hasRootIndex(nodes, '')).to.equal(true)
  })

  it('returns false when selectedPath is set', () => {
    const nodes: ContextTreeNodeDTO[] = [blob('index.html')]
    expect(hasRootIndex(nodes, 'architecture.md')).to.equal(false)
  })

  it('returns false when root has no index.html', () => {
    const nodes: ContextTreeNodeDTO[] = [blob('architecture.md'), tree('domains')]
    expect(hasRootIndex(nodes, '')).to.equal(false)
  })

  it('returns false when index.html is a folder (type tree), not a blob', () => {
    const nodes: ContextTreeNodeDTO[] = [tree('index.html')]
    expect(hasRootIndex(nodes, '')).to.equal(false)
  })

  it('ignores a nested index.html (only root-level counts)', () => {
    const nodes: ContextTreeNodeDTO[] = [tree('domains', [blob('domains/index.html')])]
    expect(hasRootIndex(nodes, '')).to.equal(false)
  })

  it('returns false when nodes is empty', () => {
    expect(hasRootIndex([], '')).to.equal(false)
  })
})

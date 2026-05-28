import {expect} from 'chai'
import sinon from 'sinon'

import {createTopicViewerNavigation} from '../../../../../../src/webui/features/context/utils/topic-viewer-navigation.js'

function makeNav({existing}: {existing: ReadonlySet<string>}) {
  const navigate = sinon.spy()
  const onStalePath = sinon.spy()
  const pathExists = (path: string) => existing.has(path)
  const nav = createTopicViewerNavigation({navigate, onStalePath, pathExists})
  return {nav, navigate, onStalePath}
}

describe('createTopicViewerNavigation', () => {
  describe('onBreadcrumbClick', () => {
    it('navigates to the joined segment path when it exists', () => {
      const {nav, navigate, onStalePath} = makeNav({existing: new Set(['architecture/auth/login.md'])})

      nav.onBreadcrumbClick(['architecture', 'auth', 'login.md'])

      expect(navigate.calledOnceWithExactly('architecture/auth/login.md')).to.equal(true)
      expect(onStalePath.called).to.equal(false)
    })

    it('handles a single-segment breadcrumb', () => {
      const {nav, navigate} = makeNav({existing: new Set(['root.md'])})

      nav.onBreadcrumbClick(['root.md'])

      expect(navigate.calledOnceWithExactly('root.md')).to.equal(true)
    })

    it('does not navigate when segments array is empty', () => {
      const {nav, navigate, onStalePath} = makeNav({existing: new Set()})

      nav.onBreadcrumbClick([])

      expect(navigate.called).to.equal(false)
      expect(onStalePath.called).to.equal(false)
    })

    it('calls onStalePath when the joined path does not exist', () => {
      const {nav, navigate, onStalePath} = makeNav({existing: new Set()})

      nav.onBreadcrumbClick(['architecture', 'gone.md'])

      expect(navigate.called).to.equal(false)
      expect(onStalePath.calledOnceWithExactly('architecture/gone.md')).to.equal(true)
    })
  })

  describe('onRelatedClick', () => {
    it('strips a leading @ before checking existence and navigating', () => {
      const {nav, navigate, onStalePath} = makeNav({existing: new Set(['architecture/auth.md'])})

      nav.onRelatedClick('@architecture/auth.md')

      expect(navigate.calledOnceWithExactly('architecture/auth.md')).to.equal(true)
      expect(onStalePath.called).to.equal(false)
    })

    it('leaves a non-prefixed path untouched', () => {
      const {nav, navigate} = makeNav({existing: new Set(['architecture/auth.md'])})

      nav.onRelatedClick('architecture/auth.md')

      expect(navigate.calledOnceWithExactly('architecture/auth.md')).to.equal(true)
    })

    it('only strips a single leading @ (not multiple)', () => {
      const {nav, navigate} = makeNav({existing: new Set(['@weird/path.md'])})

      nav.onRelatedClick('@@weird/path.md')

      expect(navigate.calledOnceWithExactly('@weird/path.md')).to.equal(true)
    })

    it('calls onStalePath with the @-stripped path when it does not exist', () => {
      const {nav, navigate, onStalePath} = makeNav({existing: new Set()})

      nav.onRelatedClick('@gone/path.md')

      expect(navigate.called).to.equal(false)
      expect(onStalePath.calledOnceWithExactly('gone/path.md')).to.equal(true)
    })
  })

  describe('onEntryClick', () => {
    it('navigates to entry.path when it exists', () => {
      const {nav, navigate, onStalePath} = makeNav({existing: new Set(['domains/auth/login.html'])})

      nav.onEntryClick({path: 'domains/auth/login.html'})

      expect(navigate.calledOnceWithExactly('domains/auth/login.html')).to.equal(true)
      expect(onStalePath.called).to.equal(false)
    })

    it('calls onStalePath when entry.path does not exist', () => {
      const {nav, navigate, onStalePath} = makeNav({existing: new Set()})

      nav.onEntryClick({path: 'domains/gone.html'})

      expect(navigate.called).to.equal(false)
      expect(onStalePath.calledOnceWithExactly('domains/gone.html')).to.equal(true)
    })
  })
})

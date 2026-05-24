import {expect} from 'chai'

import {resolveAutoSelectProject} from '../../../../../../src/webui/features/project/utils/resolve-auto-select-project'
import {encodeBase64Url} from '../../../../../../src/webui/lib/base64url'

const PROJECTS = [
  {projectPath: '/Users/foo/repo-a'},
  {projectPath: '/Users/foo/repo-b'},
  {projectPath: String.raw`C:\Users\bar\project`},
  {projectPath: '/home/Müller/проекты/repo'},
]

describe('resolveAutoSelectProject', () => {
  it('picks the URL param when it matches a project', () => {
    const result = resolveAutoSelectProject({
      projects: PROJECTS,
      urlParam: encodeBase64Url('/Users/foo/repo-b'),
    })
    expect(result).to.equal('/Users/foo/repo-b')
  })

  it('overrides an existing selectedProject when the URL param is valid', () => {
    const result = resolveAutoSelectProject({
      projects: PROJECTS,
      selectedProject: '/Users/foo/repo-a',
      urlParam: encodeBase64Url('/Users/foo/repo-b'),
    })
    expect(result).to.equal('/Users/foo/repo-b')
  })

  it('keeps the existing selectedProject when no URL param is given', () => {
    const result = resolveAutoSelectProject({
      projectCwd: '/Users/foo/repo-b',
      projects: PROJECTS,
      selectedProject: '/Users/foo/repo-a',
    })
    expect(result).to.be.undefined
  })

  it('resolves a Windows path encoded as base64url', () => {
    const result = resolveAutoSelectProject({
      projects: PROJECTS,
      urlParam: encodeBase64Url(String.raw`C:\Users\bar\project`),
    })
    expect(result).to.equal(String.raw`C:\Users\bar\project`)
  })

  it('resolves a non-ASCII path encoded as base64url', () => {
    const result = resolveAutoSelectProject({
      projects: PROJECTS,
      urlParam: encodeBase64Url('/home/Müller/проекты/repo'),
    })
    expect(result).to.equal('/home/Müller/проекты/repo')
  })

  it('returns undefined when URL param decodes to an unknown project', () => {
    const result = resolveAutoSelectProject({
      projects: PROJECTS,
      urlParam: encodeBase64Url('/Users/foo/removed-project'),
    })
    expect(result).to.be.undefined
  })

  it('falls back to projectCwd when no URL param, no selection, and cwd matches', () => {
    const result = resolveAutoSelectProject({
      projectCwd: '/Users/foo/repo-a',
      projects: PROJECTS,
    })
    expect(result).to.equal('/Users/foo/repo-a')
  })

  it('returns undefined when projectCwd is set but does not match any project', () => {
    const result = resolveAutoSelectProject({
      projectCwd: '/random/path/not/a/project',
      projects: PROJECTS,
    })
    expect(result).to.be.undefined
  })

  it('falls back to projectCwd when URL param is present but invalid and no selection', () => {
    const result = resolveAutoSelectProject({
      projectCwd: '/Users/foo/repo-a',
      projects: PROJECTS,
      urlParam: encodeBase64Url('/Users/foo/removed-project'),
    })
    expect(result).to.equal('/Users/foo/repo-a')
  })

  it('returns undefined when URL param is invalid and selection already exists', () => {
    const result = resolveAutoSelectProject({
      projectCwd: '/Users/foo/repo-a',
      projects: PROJECTS,
      selectedProject: '/Users/foo/repo-b',
      urlParam: encodeBase64Url('/Users/foo/removed-project'),
    })
    expect(result).to.be.undefined
  })

  it('returns undefined when neither URL param nor projectCwd resolves', () => {
    expect(resolveAutoSelectProject({projects: PROJECTS})).to.be.undefined
  })

  it('returns undefined when projects list is empty', () => {
    const result = resolveAutoSelectProject({
      projectCwd: '/Users/foo/repo-a',
      projects: [],
    })
    expect(result).to.be.undefined
  })

  it('tolerates malformed URL param without throwing', () => {
    const result = resolveAutoSelectProject({
      projects: PROJECTS,
      urlParam: '!!!not-base64-at-all!!!',
    })
    expect(result).to.be.undefined
  })
})

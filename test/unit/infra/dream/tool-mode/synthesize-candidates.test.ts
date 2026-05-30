import {expect} from 'chai'

import {
  findSynthesizeCandidates,
  type SynthesizeCandidateTopic,
} from '../../../../../src/server/infra/dream/tool-mode/synthesize-candidates.js'

function t(path: string, title?: string, summary?: string): SynthesizeCandidateTopic {
  return {path, summary: summary ?? '', title: title ?? path}
}

describe('findSynthesizeCandidates', () => {
  it('returns empty shape when there are no topics', async () => {
    const result = await findSynthesizeCandidates({topics: []})
    expect(result).to.deep.equal({domains: [], existingSyntheses: []})
  })

  it('groups topics by domain (first path segment)', async () => {
    const result = await findSynthesizeCandidates({
      topics: [
        t('security/jwt.html', 'JWT'),
        t('security/oauth.html', 'OAuth'),
        t('deploy/staging.html', 'Staging'),
        t('deploy/production.html', 'Production'),
      ],
    })

    expect(result.domains).to.have.length(2)
    const security = result.domains.find((d) => d.domain === 'security')
    const deploy = result.domains.find((d) => d.domain === 'deploy')
    expect(security?.topics).to.have.length(2)
    expect(deploy?.topics).to.have.length(2)
  })

  it('separates synthesis/ topics into existingSyntheses, NOT into domains', async () => {
    const result = await findSynthesizeCandidates({
      topics: [
        t('security/jwt.html', 'JWT'),
        t('security/oauth.html', 'OAuth'),
        t('synthesis/auth_strategy.html', 'Auth strategy', 'Cross-cutting auth synthesis'),
      ],
    })

    expect(result.domains).to.have.length(1)
    expect(result.domains[0].domain).to.equal('security')
    expect(result.existingSyntheses).to.have.length(1)
    expect(result.existingSyntheses[0]).to.deep.equal({
      path: 'synthesis/auth_strategy.html',
      summary: 'Cross-cutting auth synthesis',
      title: 'Auth strategy',
    })
  })

  it('filters out domains with fewer than minTopicsPerDomain (default 2)', async () => {
    const result = await findSynthesizeCandidates({
      topics: [
        t('security/jwt.html', 'JWT'),
        t('security/oauth.html', 'OAuth'),
        t('alone/single.html', 'Single'),
      ],
    })

    expect(result.domains).to.have.length(1)
    expect(result.domains[0].domain).to.equal('security')
  })

  it('respects scope: only domains whose paths start with scope are included', async () => {
    const result = await findSynthesizeCandidates({
      options: {scope: 'security/'},
      topics: [
        t('security/jwt.html', 'JWT'),
        t('security/oauth.html', 'OAuth'),
        t('deploy/a.html'),
        t('deploy/b.html'),
      ],
    })

    expect(result.domains).to.have.length(1)
    expect(result.domains[0].domain).to.equal('security')
  })

  it('includes title and summary on every topic in domains[]', async () => {
    const result = await findSynthesizeCandidates({
      topics: [
        t('security/jwt.html', 'JWT signing', 'RS256 chosen over HS256'),
        t('security/oauth.html', 'OAuth flow', 'Authorization code with PKCE'),
      ],
    })

    expect(result.domains[0].topics[0]).to.deep.equal({
      path: 'security/jwt.html',
      summary: 'RS256 chosen over HS256',
      title: 'JWT signing',
    })
  })

  it('handles topics at the root (no slash in path) by grouping them under an empty-string domain', async () => {
    const result = await findSynthesizeCandidates({
      topics: [
        t('rootless-a.html', 'Rootless A'),
        t('rootless-b.html', 'Rootless B'),
      ],
    })

    expect(result.domains).to.have.length(1)
    expect(result.domains[0].domain).to.equal('')
  })

  it('honors minTopicsPerDomain override', async () => {
    const result = await findSynthesizeCandidates({
      options: {minTopicsPerDomain: 3},
      topics: [
        t('security/jwt.html', 'JWT'),
        t('security/oauth.html', 'OAuth'),
      ],
    })

    expect(result.domains).to.deep.equal([])
  })

  it('returns the existingSyntheses regardless of the domain-min threshold', async () => {
    const result = await findSynthesizeCandidates({
      options: {minTopicsPerDomain: 10},
      topics: [
        t('security/jwt.html', 'JWT'),
        t('security/oauth.html', 'OAuth'),
        t('synthesis/x.html', 'X', 'X summary'),
      ],
    })

    expect(result.domains).to.deep.equal([])
    expect(result.existingSyntheses).to.have.length(1)
  })
})

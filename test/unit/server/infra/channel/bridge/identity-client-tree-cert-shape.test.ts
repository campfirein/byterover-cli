/* eslint-disable camelcase */
// Test fixtures mirror AMENDMENT_TOFU §A3.2 wire shape; snake_case is
// intentional.

import {expect} from 'chai'

import {__internal__validateTreeCertShape} from '../../../../../../src/server/infra/channel/bridge/identity-client.js'

// Phase 9 / Slice 9.4d — regression coverage for the strict-allowlist
// shape validator on tree-cert wire frames (kimi round-1 MEDIUM).

const validCert = () => ({
  cert_kind: 'peer-tree',
  expires_at: '2027-05-19T00:00:00.000Z',
  issued_at: '2026-05-19T00:00:00.000Z',
  parent_install: {
    install_pubkey_fingerprint: 'a'.repeat(64),
    peer_id: '12D3KooWParentInstall1111111111111111111111111',
  },
  public_key: {alg: 'ed25519', key: 'AA'.repeat(22)},
  signature: 'A'.repeat(86) + '==',
  subject_id: '0190a2e0-6b9e-7000-8000-000000000000',
  version: 1,
})

describe('validateTreeCertShape (slice 9.4d)', () => {
  it('accepts a structurally valid tree cert', () => {
    expect(() => __internal__validateTreeCertShape(validCert())).to.not.throw()
  })

  describe('rejects malformed inputs', () => {
    it('rejects null', () => {
      expect(() => __internal__validateTreeCertShape(null)).to.throw(/TREE_CERT_SHAPE_INVALID/)
    })

    it('rejects non-object scalar', () => {
      expect(() => __internal__validateTreeCertShape('a string')).to.throw(/TREE_CERT_SHAPE_INVALID/)
    })

    it('rejects when cert_kind is not "peer-tree"', () => {
      const bad = {...validCert(), cert_kind: 'install'}
      expect(() => __internal__validateTreeCertShape(bad)).to.throw(/cert_kind must be "peer-tree"/)
    })

    it('rejects when version is not 1', () => {
      const bad = {...validCert(), version: 2}
      expect(() => __internal__validateTreeCertShape(bad)).to.throw(/version must be 1/)
    })

    it('rejects when subject_id is missing', () => {
      const bad = {...validCert()} as Record<string, unknown>
      delete bad.subject_id
      expect(() => __internal__validateTreeCertShape(bad)).to.throw(/subject_id missing/)
    })

    it('rejects when parent_install is missing', () => {
      const bad = {...validCert()} as Record<string, unknown>
      delete bad.parent_install
      expect(() => __internal__validateTreeCertShape(bad)).to.throw(/parent_install missing/)
    })

    it('rejects when parent_install.peer_id is missing', () => {
      const cert = validCert()
      const bad = {...cert, parent_install: {install_pubkey_fingerprint: 'a'.repeat(64)}}
      expect(() => __internal__validateTreeCertShape(bad)).to.throw(/parent_install\.peer_id missing/)
    })

    it('rejects when parent_install.install_pubkey_fingerprint is missing', () => {
      const cert = validCert()
      const bad = {...cert, parent_install: {peer_id: '12D3'}}
      expect(() => __internal__validateTreeCertShape(bad)).to.throw(/parent_install\.install_pubkey_fingerprint missing/)
    })

    it('rejects when public_key.alg is not "ed25519"', () => {
      const cert = validCert()
      const bad = {...cert, public_key: {alg: 'rsa', key: 'AA=='}}
      expect(() => __internal__validateTreeCertShape(bad)).to.throw(/public_key\.alg must be "ed25519"/)
    })

    it('rejects an unknown top-level field (strict allowlist)', () => {
      const bad = {...validCert(), evil_field: 'sneaky'}
      expect(() => __internal__validateTreeCertShape(bad)).to.throw(/unknown cert field "evil_field"/)
    })

    it('rejects an unknown parent_install nested field', () => {
      const cert = validCert()
      const bad = {
        ...cert,
        parent_install: {...cert.parent_install, evil_nested: 'sneaky'},
      }
      expect(() => __internal__validateTreeCertShape(bad)).to.throw(/unknown parent_install field "evil_nested"/)
    })

    it('rejects an unknown public_key nested field', () => {
      const cert = validCert()
      const bad = {
        ...cert,
        public_key: {...cert.public_key, evil_key: 'sneaky'},
      }
      expect(() => __internal__validateTreeCertShape(bad)).to.throw(/unknown public_key field "evil_key"/)
    })
  })
})

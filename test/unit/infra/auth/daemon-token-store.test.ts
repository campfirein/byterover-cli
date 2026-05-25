import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {readOrCreateDaemonAuthToken} from '../../../../src/server/infra/auth/daemon-token-store.js'

// Slice 1.0 — proves the daemon-auth-token file is read-or-generated per
// DESIGN §5.6 step 1: persistent across restarts; regenerated on missing
// file or wrong permissions; never weaker than mode 0600.
describe('DaemonTokenStore', () => {
  const POSIX = process.platform !== 'win32'
  let tmpDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'brv-token-test-'))
    originalEnv = process.env.BRV_DATA_DIR
    process.env.BRV_DATA_DIR = tmpDir
  })

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.BRV_DATA_DIR
    } else {
      process.env.BRV_DATA_DIR = originalEnv
    }

    await fs.rm(tmpDir, {force: true, recursive: true})
  })

  it('generates a fresh 256-bit hex token when the file does not exist', async () => {
    const token = await readOrCreateDaemonAuthToken()

    expect(token).to.be.a('string')
    expect(token).to.have.lengthOf(64) // 32 bytes hex-encoded
    expect(token).to.match(/^[0-9a-f]{64}$/)
  })

  it('persists the token to <BRV_DATA_DIR>/state/daemon-auth-token', async () => {
    const token = await readOrCreateDaemonAuthToken()
    const tokenPath = join(tmpDir, 'state', 'daemon-auth-token')

    const persisted = await fs.readFile(tokenPath, 'utf8')
    expect(persisted.trim()).to.equal(token)
  })

  it('writes the file with mode 0600 on POSIX systems', async function () {
    if (!POSIX) {
      this.skip()
      return
    }

    await readOrCreateDaemonAuthToken()
    const tokenPath = join(tmpDir, 'state', 'daemon-auth-token')
    const stat = await fs.stat(tokenPath)

    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).to.equal(0o600)
  })

  it('reuses the existing token across calls', async () => {
    const first = await readOrCreateDaemonAuthToken()
    const second = await readOrCreateDaemonAuthToken()
    const third = await readOrCreateDaemonAuthToken()

    expect(first).to.equal(second)
    expect(second).to.equal(third)
  })

  it('regenerates the token when the file has wrong permissions (POSIX)', async function () {
    if (!POSIX) {
      this.skip()
      return
    }

    const first = await readOrCreateDaemonAuthToken()
    const tokenPath = join(tmpDir, 'state', 'daemon-auth-token')

    // Loosen perms to simulate tampering or accidental chmod.
    await fs.chmod(tokenPath, 0o644)

    const second = await readOrCreateDaemonAuthToken()
    expect(second).to.not.equal(first)

    const stat = await fs.stat(tokenPath)
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).to.equal(0o600)
  })

  it('regenerates the token when the file is empty', async () => {
    await readOrCreateDaemonAuthToken()
    const tokenPath = join(tmpDir, 'state', 'daemon-auth-token')
    await fs.writeFile(tokenPath, '', {mode: 0o600})

    const fresh = await readOrCreateDaemonAuthToken()
    expect(fresh).to.have.lengthOf(64)
    expect(fresh).to.not.equal('')
  })
})

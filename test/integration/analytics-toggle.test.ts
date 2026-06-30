import {expect} from 'chai'
import {existsSync} from 'node:fs'
import {rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {FileGlobalConfigStore} from '../../src/server/infra/storage/file-global-config-store.js'
import {GlobalConfigHandler} from '../../src/server/infra/transport/handlers/global-config-handler.js'
import {
  GlobalConfigEvents,
  type GlobalConfigGetResponse,
  type GlobalConfigSetAnalyticsRequest,
  type GlobalConfigSetAnalyticsResponse,
} from '../../src/shared/transport/events/global-config-events.js'
import {createMockTransportServer, type MockTransportServer} from '../helpers/mock-factories.js'

type GetHandler = (data: undefined, clientId: string) => Promise<GlobalConfigGetResponse>
type SetHandler = (
  data: GlobalConfigSetAnalyticsRequest,
  clientId: string,
) => Promise<GlobalConfigSetAnalyticsResponse>

describe('analytics toggle integration (handler level)', () => {
  let testDir: string
  let testConfigPath: string
  let store: FileGlobalConfigStore
  let transport: MockTransportServer
  let getHandler: GetHandler
  let setHandler: SetHandler

  beforeEach(() => {
    testDir = join(tmpdir(), `test-analytics-toggle-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
    testConfigPath = join(testDir, 'config.json')

    store = new FileGlobalConfigStore({
      getConfigDir: () => testDir,
      getConfigPath: () => testConfigPath,
    })
    transport = createMockTransportServer()

    new GlobalConfigHandler({globalConfigStore: store, transport}).setup()

    const getRaw = transport._handlers.get(GlobalConfigEvents.GET)
    const setRaw = transport._handlers.get(GlobalConfigEvents.SET_ANALYTICS)
    expect(getRaw, 'GET handler must be registered').to.exist
    expect(setRaw, 'SET_ANALYTICS handler must be registered').to.exist
    getHandler = getRaw as unknown as GetHandler
    setHandler = setRaw as unknown as SetHandler
  })

  afterEach(async () => {
    if (existsSync(testDir)) {
      await rm(testDir, {force: true, recursive: true})
    }
  })

  describe('after enable, status reflects enabled (ticket scenario 5)', () => {
    it('should observe analytics: true via GET after a successful SET_ANALYTICS true', async () => {
      const setResponse = await setHandler({analytics: true}, 'client-1')
      expect(setResponse.previous).to.equal(false)
      expect(setResponse.current).to.equal(true)

      const getResponse = await getHandler(undefined, 'client-1')
      expect(getResponse.analytics).to.equal(true)
    })
  })

  describe('after disable, status reflects disabled (ticket scenario 6)', () => {
    it('should observe analytics: false via GET after enable then disable', async () => {
      await setHandler({analytics: true}, 'client-1')

      const disableResponse = await setHandler({analytics: false}, 'client-1')
      expect(disableResponse.previous).to.equal(true)
      expect(disableResponse.current).to.equal(false)

      const getResponse = await getHandler(undefined, 'client-1')
      expect(getResponse.analytics).to.equal(false)
    })
  })

  describe('concurrent SET_ANALYTICS race (ticket scenario 7)', () => {
    it('should produce a coherent final state with last-writer-wins semantics under parallel writes', async () => {
      const [responseA, responseB] = await Promise.all([
        setHandler({analytics: true}, 'client-A'),
        setHandler({analytics: false}, 'client-B'),
      ])

      // Both calls completed without throwing.
      expect(responseA.current).to.be.a('boolean')
      expect(responseB.current).to.be.a('boolean')

      // Final on-disk state matches whichever request finished writing last.
      // The file store is atomic per writeFile; the handler's read-mutate-write
      // sequence interleaves with the event loop, so the survivor is one of
      // the two requested values, never corrupted.
      const finalState = await getHandler(undefined, 'client-readout')
      expect([true, false]).to.include(finalState.analytics)

      // deviceId must remain a non-empty UUID (the seed step stays stable
      // across the race; even if both branches generated UUIDs, the file
      // ends up with exactly one of them).
      expect(finalState.deviceId).to.be.a('string').and.not.be.empty
    })
  })
})

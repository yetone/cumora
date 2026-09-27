import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'

let server: ViteDevServer
let auth: typeof import('../src/stores/auth')
let pairingCodes: typeof import('../src/stores/pairing-codes')['usePairingCodes']
let api: typeof import('../src/api/client')['api']
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

before(async () => {
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } })
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
    server: { middlewareMode: true, watch: null },
    appType: 'custom',
  })
  auth = await server.ssrLoadModule('/src/stores/auth.ts') as typeof auth
  pairingCodes = (await server.ssrLoadModule('/src/stores/pairing-codes.ts')).usePairingCodes
  const client = await server.ssrLoadModule('/src/api/client.ts')
  api = client.api
  mock.method(client.ws, 'reconnect', () => {})
  mock.method(client.ws, 'close', () => {})
})

after(async () => {
  mock.restoreAll()
  await server?.close()
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test('a rotation response arriving after logout cannot restore the workspace code', async () => {
  auth.useAuth.getState().clear()
  auth.useAuth.getState().setMe(
    { id: 'user-a', email: 'a@example.test', name: 'User A' },
    [{ id: 'company-a', name: 'Workspace A', slug: 'workspace-a', role: 'owner' }],
    'company-a',
  )

  const initialVersion = pairingCodes.getState().beginRequest('company-a')
  pairingCodes.getState().setCodeIfCurrent('company-a', initialVersion, 'old-code')

  const response = deferred<{ code: string; expiresInSeconds: null }>()
  const stub = mock.method(api, 'rotatePairingCode', () => response.promise)
  const rotation = async () => {
    const targetCompanyId = auth.useAuth.getState().activeCompanyId!
    const requestVersion = pairingCodes.getState().beginRequest(targetCompanyId, true)
    const result = await api.rotatePairingCode()
    pairingCodes.getState().setCodeIfCurrent(targetCompanyId, requestVersion, result.code)
  }

  try {
    const pendingRotation = rotation()
    assert.equal(pairingCodes.getState().code, null)
    auth.useAuth.getState().clear()
    response.resolve({ code: 'new-code', expiresInSeconds: null })
    await pendingRotation

    assert.equal(pairingCodes.getState().companyId, null)
    assert.equal(pairingCodes.getState().code, null)
  } finally {
    stub.mock.restore()
  }
})

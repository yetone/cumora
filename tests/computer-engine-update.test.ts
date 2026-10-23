import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

// Execute the real click handler without adding a React test framework.
const source = ts.createSourceFile('MeView.tsx',
  readFileSync(new URL('../src/desktop/MeView.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let handler = ''
function findHandler(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'updateEngine') handler = node.getText(source)
  ts.forEachChild(node, findHandler)
}
findHandler(source)
assert.ok(handler, 'the engine update click handler must exist')
const javascript = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

for (const outcome of ['succeeded', 'failed'] as const) {
  test(`engine update ignores ordinary scans and waits for its own ${outcome} result`, async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    let status: 'running' | typeof outcome = 'running'
    let busy: string | null = null
    let error: string | null = null
    let reads = 0
    const computer = { name: 'Test computer', enginesDetectedAt: 'before' }
    const context = vm.createContext({
      ENGINE_UPDATE_TTL_SECONDS: 900,
      api: {
        updateComputerEngine: async () => ({ updateId: 'operation-1' }),
        getComputerEngineUpdate: async (id: string, updateId: string) => {
          assert.equal(id, 'computer')
          assert.equal(updateId, 'operation-1')
          reads++
          return { status, error: outcome === 'failed' ? 'fixture upgrade failed' : undefined }
        },
      },
      useComputers: { getState: () => ({
        byId: { computer },
        refresh: async () => { computer.enginesDetectedAt = 'unrelated-scan' },
      }) },
      setErr: (value: string | null) => { error = value },
      setUpdatingCli: (value: string | null) => { busy = value },
      window: { setTimeout: (callback: () => void) => { void pending.then(callback) } },
      Date, t: (key: string) => key,
    })
    vm.runInContext(`${javascript}; globalThis.runUpdate = updateEngine`, context)
    const running = context.runUpdate('computer', 'codex') as Promise<void>
    await new Promise<void>((resolve) => setImmediate(resolve))
    computer.enginesDetectedAt = 'manual-refresh'
    assert.equal(busy, 'computer:codex')
    assert.equal(error, null)
    status = outcome
    release()
    await running
    assert.equal(reads, 2)
    assert.equal(busy, null)
    assert.equal(error, outcome === 'failed' ? 'fixture upgrade failed' : null)
  })
}

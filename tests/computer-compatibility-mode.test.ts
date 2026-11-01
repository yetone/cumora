import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { cn } from '../src/lib/utils'

// Run the real card and confirmation effect without adding a React test framework.
const source = ts.createSourceFile('MeView.tsx',
  readFileSync(new URL('../src/desktop/MeView.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let card = ''
let polling = ''
function visit(node: ts.Node): void {
  if (ts.isCallExpression(node)) {
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.getText(source) === 'list.map') {
      card = node.arguments[0].getText(source)
    }
    if (node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes('hasPendingMode')) {
      polling = node.arguments[0].getText(source)
    }
  }
  ts.forEachChild(node, visit)
}
visit(source)
assert.ok(card)
assert.ok(polling)
function evaluate(code: string, context: Record<string, unknown>) {
  return vm.runInNewContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText, context)
}

for (const enabled of [false, true]) {
  for (const pending of [false, true]) {
    test(`compatibility card: desired=${enabled}, pending=${pending} survives remount`, () => {
      const element = evaluate(`(${card})`, {
        React, cn, t: (key: string) => key, agentCount: () => 0, repairFor: null,
        enginesOpen: new Set(), repairCode: null, pairedRows: () => [], busyId: null,
        modeBusyId: null, KIND_ICON: {}, STATUS_COLOR: {}, COMPUTER_STATUS_KEY: {},
      })({ id: 'test-computer', name: 'Test computer', kind: 'desktop', status: 'online',
        unsandboxedEnabled: enabled, unsandboxedActive: pending ? !enabled : enabled })
      const html = renderToStaticMarkup(element)
      assert.match(html, new RegExp(`aria-checked="${enabled}"`))
      assert.match(html, new RegExp(`aria-busy="${pending}"`))
      if (pending) {
        assert.match(html, /me\.unsandboxedPending</)
        assert.match(html, new RegExp(`me\\.unsandboxedPending${enabled ? 'On' : 'Off'}<`))
        assert.doesNotMatch(html, /me\.unsandboxedActive</)
        assert.doesNotMatch(html, /me\.compatibilityDisabled</)
      } else {
        assert.match(html, new RegExp(`me\\.compatibility${enabled ? 'Enabled' : 'Disabled'}<`))
        assert.equal(html.includes('me.unsandboxedActive<'), enabled)
      }
      if (enabled) assert.match(html, /bg-skype/)
      assert.doesNotMatch(html, /#ffd36b|#ff9b57|#f47861/)
    })
  }
}

test('a remounted pending card resumes bounded confirmation polling and cleans up', () => {
  let reads = 0
  const cleared: number[] = []
  let tick = () => {}
  let expire = () => {}
  const effect = evaluate(`(${polling})`, {
    hasPendingMode: true, modeBusyId: null,
    useComputers: { getState: () => ({ refresh: () => { reads++ } }) },
    window: {
      setInterval: (callback: () => void, delay: number) => { assert.equal(delay, 1000); tick = callback; return 1 },
      setTimeout: (callback: () => void, delay: number) => { assert.equal(delay, 45_000); expire = callback; return 2 },
      clearInterval: (id: number) => { cleared.push(id) },
      clearTimeout: (id: number) => { cleared.push(id) },
    },
  })
  const cleanup = effect()
  tick()
  assert.equal(reads, 1)
  expire()
  assert.deepEqual(cleared, [1])
  cleanup()
  assert.deepEqual(cleared, [1, 1, 2])
})

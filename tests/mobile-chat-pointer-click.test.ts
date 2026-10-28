import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useLongPress } from '../src/mobile/useLongPress'

function pressHandlers() {
  let taps = 0
  let handlers: ReturnType<typeof useLongPress> | undefined
  renderToStaticMarkup(createElement(() => {
    handlers = useLongPress(() => {}, () => { taps++ })
    return null
  }))
  assert.ok(handlers)
  return { handlers, taps: () => taps }
}

function click(handlers: ReturnType<typeof useLongPress>, nativeEvent: object, detail = 1) {
  const onClick = (handlers as typeof handlers & {
    onClick?: (event: { preventDefault: () => void; nativeEvent: object; detail: number }) => void
  }).onClick
  assert.equal(typeof onClick, 'function', 'conversation taps need a click handler')
  onClick({ preventDefault() {}, nativeEvent, detail })
}

test('long-press-only message rows leave nested links clickable', () => {
  let handlers: ReturnType<typeof useLongPress> | undefined
  renderToStaticMarkup(createElement(() => {
    handlers = useLongPress(() => {})
    return null
  }))
  assert.ok(handlers)
  assert.equal('onClick' in handlers, false)
})

test('desktop mouse and keyboard clicks open a narrow-layout conversation', () => {
  const { handlers, taps } = pressHandlers()
  click(handlers, { pointerType: 'mouse' })
  click(handlers, {}, 0)
  assert.equal(taps(), 2)
})

test('touch-generated click does not open the conversation twice', () => {
  const { handlers, taps } = pressHandlers()
  handlers.onTouchEnd()
  click(handlers, { pointerType: 'touch' })
  click(handlers, { sourceCapabilities: { firesTouchEvents: true } })
  assert.equal(taps(), 1)
  click(handlers, {}, 1)
  assert.equal(taps(), 2, 'an untagged mouse click after touch is not swallowed')
  click(handlers, { pointerType: 'mouse' })
  assert.equal(taps(), 3, 'a subsequent trackpad click still opens the conversation')
})

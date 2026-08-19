const { app, nativeImage } = require('electron')
const fs = require('fs'), path = require('path')

// Pull the REAL constants + paint function out of the shipped source and run
// them, so this verifies the actual code rather than a copy of it.
const src = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8')
const pick = (re, what) => { const m = src.match(re); if (!m) throw new Error('could not extract ' + what); return m[0] }
const consts = pick(/const DOCK_ICON_SIZE = \d+\nconst DOCK_UNREAD_DOT = \{[\s\S]*?\n\}/, 'constants')
const fn = pick(/function paintDockUnreadDot\(buf, width, height\) \{[\s\S]*?\n\}\n(?=\nfunction getDockUnreadIcon)/, 'paintDockUnreadDot')
const mod = { exports: {} }
new Function('module', consts + '\n' + fn + '\nmodule.exports = { paintDockUnreadDot, DOCK_ICON_SIZE, DOCK_UNREAD_DOT }')(mod)
const { paintDockUnreadDot, DOCK_ICON_SIZE, DOCK_UNREAD_DOT } = mod.exports

app.whenReady().then(() => {
  const ICON = path.join(__dirname, '..', 'build', 'icon.png')
  const base = nativeImage.createFromPath(ICON)
  const { width, height } = base.getSize()
  console.log('base icon:', width + 'x' + height, 'isEmpty:', base.isEmpty())

  const buf = base.toBitmap()
  const s = Math.min(width, height) / DOCK_ICON_SIZE
  const cx = Math.round(DOCK_UNREAD_DOT.cx * s), cy = Math.round(DOCK_UNREAD_DOT.cy * s)
  const at = (b, x, y) => { const i = (y * width + x) * 4; return { B: b[i], G: b[i+1], R: b[i+2], A: b[i+3] } }
  const before = at(buf, cx, cy)

  paintDockUnreadDot(buf, width, height)
  const after = at(buf, cx, cy)
  const img = nativeImage.createFromBitmap(buf, { width, height })

  console.log('dot centre before:', JSON.stringify(before))
  console.log('dot centre after :', JSON.stringify(after), '(want R=255 G=59 B=48 A=255)')
  console.log('result isEmpty   :', img.isEmpty(), 'size:', JSON.stringify(img.getSize()))
  // a pixel far from the dot must be untouched
  const farBefore = at(base.toBitmap(), 10, 10), farAfter = at(buf, 10, 10)
  console.log('far pixel unchanged:', JSON.stringify(farBefore) === JSON.stringify(farAfter))
  // premultiplied invariant: every channel <= alpha
  let bad = 0
  for (let i = 0; i < buf.length; i += 4) if (buf[i] > buf[i+3] || buf[i+1] > buf[i+3] || buf[i+2] > buf[i+3]) bad++
  console.log('premultiplied violations:', bad)
  app.exit(0)
})

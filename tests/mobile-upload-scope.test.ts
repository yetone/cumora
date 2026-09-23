/**
 * A file picked in conversation A must never land in conversation B.
 *
 * MobileChat's `upload()` function is async: `await api.uploadFile(file)`
 * resolves after a network round-trip. If the user taps a different
 * conversation before that round-trip completes, `convoId` in the component
 * refers to the new conversation — and the bare `setAttachment(a)` call would
 * attach the file there instead of where the pick happened.
 *
 * The desktop counterpart (ChatPane.tsx) avoids the same hazard with a
 * `targetScope` parameter captured at call-time. MobileChat cannot use
 * scope-keyed state, so it instead captures `convoId` in a local variable
 * (`targetConvoId`) and compares it against a `convoIdRef` that is kept
 * current via a `useEffect`. Every async callback that mutates composer
 * state must pass that guard before writing.
 *
 * This is a source-inspection test. There is no React harness in this repo,
 * so we read the file and assert the guard pattern is present. If it ever
 * moves, update the anchor string below.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

const MOBILE_CHAT = new URL('../src/mobile/MobileChat.tsx', import.meta.url)

/** The body of the upload function. */
async function uploadBody(): Promise<string> {
  const source = await readFile(MOBILE_CHAT, 'utf8')
  const start = source.indexOf('const upload = async (file: File)')
  assert.notEqual(start, -1, 'upload() moved or was renamed; this guard needs updating')
  return source.slice(start, start + 800)
}

describe('mobile upload does not straddle a conversation switch', () => {
  it('captures the conversation id before the await', async () => {
    assert.ok(
      (await uploadBody()).includes('const targetConvoId = convoId'),
      'upload() does not capture convoId — an attachment can land in the wrong conversation',
    )
  })

  it('guards setAttachment with the captured id', async () => {
    assert.match(
      await uploadBody(),
      /convoIdRef\.current === targetConvoId.*setAttachment/s,
      'setAttachment is not guarded — a completed upload can write into a different conversation',
    )
  })

  it('guards setUploadError with the captured id', async () => {
    assert.match(
      await uploadBody(),
      /convoIdRef\.current === targetConvoId.*setUploadError/s,
      'setUploadError is not guarded — an upload error can surface in a different conversation',
    )
  })

  it('guards the finally setUploading with the captured id', async () => {
    assert.match(
      await uploadBody(),
      /convoIdRef\.current === targetConvoId.*setUploading\(false\)/s,
      'setUploading(false) in finally is not guarded — the spinner can clear in a different conversation',
    )
  })
})

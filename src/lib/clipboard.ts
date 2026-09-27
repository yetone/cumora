/** Copy text through Electron when available. Chromium requires a focused
 * document for navigator.clipboard, which can lag after a native dialog. */
export async function copyText(text: string): Promise<void> {
  if (window.cumora?.clipboard?.writeText) {
    await window.cumora.clipboard.writeText(text)
    return
  }
  if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
  await navigator.clipboard.writeText(text)
}

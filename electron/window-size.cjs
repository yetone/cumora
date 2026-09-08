/**
 * How large the main window opens.
 *
 * Two different questions were being answered by one expression:
 *
 *   FIRST RUN — the 1480×920 default has to fit a small laptop, or macOS
 *   clamps it on launch and the app feels like it opened fullscreen. Capping
 *   at 90% of the work area is the fix, and is what the comment describes.
 *
 *   RESTORING — the saved size is the size the user chose. Shaving 10% off it
 *   on every launch is not a cap, it is a slow shrink, and because
 *   `persistState` writes the new bounds back on the first resize event, the
 *   size they picked is overwritten and gone.
 *
 * The old code applied the 90% cap to both, against the PRIMARY display's work
 * area regardless of which display the window was being restored onto. On a
 * laptop plus a large external, a window sized 2300×1300 on the external came
 * back at the laptop's 90% — roughly a third of its area — and that third was
 * then saved over the original.
 *
 * So: cap the default, fit the saved size. "Fit" still bounds it to the work
 * area of the display it is actually landing on, because a monitor that was
 * unplugged since last quit should not produce a window larger than what is
 * left — it just no longer takes a 10% bite out of a size that already fits.
 *
 * Pure and electron-free so the arithmetic can be tested, the same split as
 * cli-path.cjs.
 */

/**
 * @param {{width?: number, height?: number}} saved     last-quit size, or the defaults on first run
 * @param {{width: number, height: number}} defaults    DEFAULT_WINDOW_STATE
 * @param {{width: number, height: number}} workArea    work area of the display the window will open on
 * @param {boolean} restoring                           true when `saved` came from disk
 */
function initialWindowSize(saved, defaults, workArea, restoring) {
  const cap = restoring ? 1 : 0.9
  return {
    width: Math.min(saved?.width ?? defaults.width, Math.round(workArea.width * cap)),
    height: Math.min(saved?.height ?? defaults.height, Math.round(workArea.height * cap)),
  }
}

module.exports = { initialWindowSize }

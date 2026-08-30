/**
 * Twemoji renderer — converts a unicode emoji to its Twemoji SVG image so
 * the look matches across platforms (macOS / Windows / Linux render emoji
 * very differently). Uses jdecked/twemoji (the active fork after Twitter
 * archived the original repo) via jsDelivr CDN.
 *
 * On failed load (rare codepoints, network blip), falls back to native emoji.
 */
import { useState } from 'react'

/**
 * Convert an emoji string to its Twemoji filename codepoint sequence.
 * Drops VS-16 (`FE0F`) which Twemoji files omit unless the emoji uses ZWJ.
 */
export function twemojiCodePoints(emoji: string): string {
  const cps: number[] = []
  let prev = 0
  for (const ch of emoji) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0xfe0f && prev !== 0x200d) {
      // skip variation selector (Twemoji omits it from filenames)
      continue
    }
    cps.push(cp)
    prev = cp
  }
  return cps.map((c) => c.toString(16)).join('-')
}

export function twemojiUrl(emoji: string): string {
  return `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/svg/${twemojiCodePoints(emoji)}.svg`
}

interface Props {
  emoji: string
  /** rendered pixel size (square) */
  size?: number
  className?: string
}

export function TwEmoji({ emoji, size = 16, className }: Props) {
  const [errored, setErrored] = useState(false)
  if (errored) {
    // Native fallback — keep the inline-baseline alignment so layout stays put.
    return (
      <span
        role="img"
        className={className}
        style={{ fontSize: size, lineHeight: 1, display: 'inline-block', verticalAlign: 'text-bottom' }}
        aria-label={emoji}
      >{emoji}</span>
    )
  }
  return (
    <img
      src={twemojiUrl(emoji)}
      alt={emoji}
      draggable={false}
      width={size}
      height={size}
      className={className}
      style={{
        display: 'inline-block',
        verticalAlign: 'text-bottom',
        // Slight optical lift so the emoji glyph baseline matches text.
        marginBottom: 1,
        userSelect: 'none',
      }}
      onError={() => setErrored(true)}
    />
  )
}

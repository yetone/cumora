import { CloudLogo } from '@/components/Avatar'
import { CompanySwitcher } from '@/components/CompanySwitcher'
import { isElectron, trafficLightInset } from '@/lib/runtime'
import { useT } from '@/lib/i18n'

export function TitleBar() {
  const t = useT()
  // In Electron with hidden titleBarStyle on mac, native traffic lights land in this strip.
  // Reserve space on the left for them, and make the bar a draggable region.
  const dragStyle = isElectron
    ? { WebkitAppRegion: 'drag' as const, userSelect: 'none' as const }
    : {}

  // Three equal-flex columns so the middle cell (and therefore the title)
  // is anchored to the WINDOW's horizontal center regardless of how wide
  // the left (traffic lights) or right (workspace switcher) cells happen
  // to be. The auto middle column shrinks to the title's intrinsic width,
  // so the 1fr cells on either side balance perfectly.
  const reservedLeft = Math.max(84, trafficLightInset)
  return (
    <header
      className="grid items-center px-4 border-b border-ink-100"
      style={{
        height: 44,
        background: 'var(--chrome)',
        gridTemplateColumns: `1fr auto 1fr`,
        ...dragStyle,
      }}
    >
      {!isElectron ? (
        <div className="flex gap-2" style={{ paddingLeft: 0 }}>
          <span className="w-3 h-3 rounded-full" style={{ background: '#FF6058', boxShadow: 'inset 0 -1px 0 rgba(0,0,0,0.1)' }} />
          <span className="w-3 h-3 rounded-full" style={{ background: '#FFBD2E', boxShadow: 'inset 0 -1px 0 rgba(0,0,0,0.1)' }} />
          <span className="w-3 h-3 rounded-full" style={{ background: '#28C940', boxShadow: 'inset 0 -1px 0 rgba(0,0,0,0.1)' }} />
        </div>
      ) : (
        // Empty cell — native traffic lights paint over this region on mac.
        // We still need at least `reservedLeft` of width so the title's 1fr
        // start can't push back to 0 (which would let the title slide under
        // the traffic lights).
        <div style={{ minWidth: reservedLeft }} />
      )}
      <div className="flex items-center justify-center gap-2.5 font-display font-medium text-[14px] text-ink-700 tracking-wide whitespace-nowrap">
        <CloudLogo />
        <span>Cumora</span>
        <em className="font-normal text-ink-500" style={{ fontStyle: 'italic' }}>{t('common.titlebarTagline')}</em>
      </div>
      <div className="flex items-center justify-end pr-2">
        <CompanySwitcher />
      </div>
    </header>
  )
}

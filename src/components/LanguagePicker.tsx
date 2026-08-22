/**
 * Language picker — the one control that switches the UI locale.
 *
 * Shared by desktop Preferences and the mobile You screen so the two
 * shells can't drift apart on which locales exist or how the choice is
 * worded. The switch takes effect immediately: every component that
 * renders through `useT()` is subscribed to the locale store, so there's
 * no reload and no "restart to apply".
 */
import { Select } from '@/components/Select'
import { LOCALES, useLocaleStore, useT, type Locale } from '@/lib/i18n'

export function LanguagePicker({ className }: { className?: string }) {
  const t = useT()
  const locale = useLocaleStore((s) => s.locale)
  const setLocale = useLocaleStore((s) => s.setLocale)

  return (
    <Select<Locale>
      className={className}
      value={locale}
      ariaLabel={t('common.language')}
      onValueChange={setLocale}
      // `label` is the language's own name; `hint` is its English name, so
      // someone stuck in a language they can't read can still find their
      // way back out.
      options={LOCALES.map((l) => ({ value: l.code, label: l.label, hint: l.english }))}
    />
  )
}

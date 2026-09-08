/**
 * Modal for inviting humans to a company workspace.
 *
 * Two flows surfaced from the same modal:
 *   1. **Shareable link** — mint a long-lived multi-use invite the owner
 *      can paste into Slack / iMessage / wherever. No email required.
 *   2. **By email**       — mint a single-use invite locked to a specific
 *      address. The owner copies the link and sends it themselves
 *      (we don't run an SMTP relay).
 *
 * Below the form, a live list of existing invitations with copy / revoke
 * affordances so the owner can audit who they've invited.
 *
 * Only company owners/admins reach this screen — the backend enforces it
 * with 403 on every endpoint, and the UI hides the entry points for
 * regular members.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { type ApiInvitation, type ApiInvitationWithToken, api } from '@/api/client'
import { useT } from '@/lib/i18n'
import { useAuth } from '@/stores/auth'

interface Props {
  companyId: string
  companyName: string
  actorRole: string
  onClose: () => void
}

type Tab = 'link' | 'email'

export function InvitePeopleModal({ companyId, companyName, actorRole, onClose }: Props) {
  const t = useT()
  const [tab, setTab] = useState<Tab>('link')
  const [list, setList] = useState<ApiInvitation[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [listErr, setListErr] = useState<string | null>(null)

  // Form state
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'member' | 'admin'>('member')
  const [note, setNote] = useState('')
  // Email-tab checkbox: ask the server to send the invite as an email on
  // the inviter's behalf. Only meaningful on the email tab (a shareable
  // link has no recipient). Default ON when the server has outbound
  // email configured; the checkbox is hidden entirely otherwise.
  const [sendEmail, setSendEmail] = useState(true)
  const [busy, setBusy] = useState(false)
  const [formErr, setFormErr] = useState<string | null>(null)
  const emailCapable = useAuth((s) => s.serverCapabilities?.invitationEmail === true)
  /** The just-created invite, kept around so the owner can copy the URL.
   *  Cleared on tab switch or on close. */
  const [created, setCreated] = useState<ApiInvitationWithToken | null>(null)

  const reload = useCallback(async () => {
    setLoadingList(true); setListErr(null)
    try {
      const rows = await api.listInvitations(companyId)
      setList(rows)
    } catch (e) {
      setListErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingList(false)
    }
  }, [companyId])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async () => {
    setFormErr(null); setCreated(null)
    if (tab === 'email') {
      const trimmed = email.trim()
      if (!trimmed) { setFormErr(t('invite.addEmailErr')); return }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) { setFormErr(t('invite.invalidEmailErr')); return }
    }
    setBusy(true)
    try {
      const payload = tab === 'email'
        ? { email: email.trim(), role, note: note.trim() || null, sendEmail: emailCapable && sendEmail }
        : { multiUse: true, role, note: note.trim() || null }
      const inv = await api.createInvitation(companyId, payload)
      setCreated(inv)
      setEmail(''); setNote('')
      void reload()
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string) => {
    try {
      await api.revokeInvitation(companyId, id)
      void reload()
    } catch (e) {
      setListErr(e instanceof Error ? e.message : String(e))
    }
  }

  const activeInvitations = useMemo(() => list.filter((i) => i.status === 'active'), [list])
  const historicalInvitations = useMemo(() => list.filter((i) => i.status !== 'active'), [list])

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-6"
      style={{ background: 'rgba(15, 30, 50, 0.55)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
    >
      <div
        className="bg-cloud rounded-[18px] shadow-pop w-full max-w-[600px] max-h-[88vh] flex flex-col overflow-hidden"
        style={{ border: '1px solid var(--ink-100)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-ink-100 shrink-0">
          <h2 className="font-display font-medium text-[20px] tracking-tight">
            {t('invite.title', { name: companyName })}
          </h2>
          <div className="text-[12.5px] text-ink-500 italic font-display mt-0.5">
            {t('invite.intro')}
          </div>
        </div>

        <div className="px-6 py-5 overflow-y-auto flex-1 min-h-0 space-y-5">
          {/* Tabs */}
          <div className="inline-flex rounded-[10px] p-0.5 bg-paper" style={{ border: '1px solid var(--ink-100)' }}>
            {(['link', 'email'] as const).map((tabKey) => {
              const on = tab === tabKey
              return (
                <button
                  key={tabKey}
                  type="button"
                  onClick={() => { setTab(tabKey); setCreated(null); setFormErr(null) }}
                  className="px-3 py-1.5 text-[12.5px] font-semibold rounded-[8px] transition"
                  style={{
                    background: on ? 'var(--skype)' : 'transparent',
                    color: on ? 'white' : 'var(--ink-500)',
                  }}
                >
                  {tabKey === 'link' ? t('invite.tabLink') : t('invite.tabEmail')}
                </button>
              )
            })}
          </div>

          {/* Form */}
          {tab === 'email' && (
            <div className="space-y-3">
              <div>
                <label className="block text-[11px] font-bold tracking-wider uppercase text-ink-500 mb-1">
                  {t('invite.fieldEmail')}
                </label>
                <div className="text-[11.5px] text-ink-300 mb-1.5 font-display italic">
                  {t('invite.emailHelp')}
                </div>
                <input
                  type="email"
                  autoFocus
                  autoComplete="off"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="teammate@example.com"
                  className="ip-input"
                />
              </div>

              {emailCapable && (
                <label className="flex items-start gap-2.5 cursor-pointer select-none rounded-[10px] px-3 py-2.5 transition"
                       style={{ background: 'var(--paper)', border: '1px solid var(--ink-100)' }}>
                  <input
                    type="checkbox"
                    checked={sendEmail}
                    onChange={(e) => setSendEmail(e.target.checked)}
                    className="mt-0.5 accent-[color:var(--skype)] w-[15px] h-[15px] cursor-pointer"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-[12.5px] font-semibold text-ink-800">
                      {t('invite.sendEmailLabel')}
                    </span>
                    <span className="block text-[11.5px] text-ink-400 font-display italic mt-0.5 leading-snug">
                      {t('invite.sendEmailDetail')}
                    </span>
                  </span>
                </label>
              )}
            </div>
          )}

          {tab === 'link' && (
            <div className="rounded-[10px] p-3 text-[12px] text-ink-500 font-display italic" style={{ background: 'var(--paper)', border: '1px dashed var(--ink-200)' }}>
              {t('invite.linkHelp')}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-bold tracking-wider uppercase text-ink-500 mb-1">
                {t('invite.fieldRole')}
              </label>
              <div className="flex gap-1.5">
                {(actorRole === 'owner' ? ['member', 'admin'] as const : ['member'] as const).map((r) => {
                  const on = role === r
                  return (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setRole(r)}
                      className="px-3 py-1.5 rounded-[8px] text-[12px] font-semibold transition"
                      style={{
                        background: on ? 'var(--ink-700)' : 'var(--paper)',
                        color: on ? 'white' : 'var(--ink-500)',
                        border: '1px solid var(--ink-100)',
                      }}
                    >
                      {r === 'member' ? t('invite.roleMember') : t('invite.roleAdmin')}
                    </button>
                  )
                })}
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-bold tracking-wider uppercase text-ink-500 mb-1">
                {t('invite.fieldNote')}
                <span className="ml-1.5 text-ink-300 normal-case font-medium tracking-normal">{t('invite.optional')}</span>
              </label>
              <input
                type="text"
                maxLength={120}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t('invite.notePh')}
                className="ip-input"
              />
            </div>
          </div>

          {formErr && (
            <div className="text-[12.5px] text-coral-deep bg-coral-soft py-2 px-3 rounded-lg">
              {formErr}
            </div>
          )}

          {created && <CreatedInviteCard invite={created} onDone={() => setCreated(null)} />}

          <div>
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className="w-full py-2.5 rounded-[10px] text-[13px] font-semibold text-white transition disabled:opacity-50"
              style={{
                background: 'var(--skype)',
                boxShadow: '0 4px 12px -3px rgba(0, 168, 240, 0.5)',
              }}
            >
              {busy ? t('invite.busyCreating')
                : tab === 'email' ? t('invite.createEmailBtn')
                : t('invite.createLinkBtn')}
            </button>
          </div>

          {/* Existing invitations */}
          <div className="pt-2">
            <div className="flex items-center gap-2 mb-2">
              <h3 className="text-[12.5px] font-bold tracking-wide uppercase text-ink-500">
                {t('invite.pendingTitle')}
              </h3>
              <span className="text-[11px] text-ink-300">{activeInvitations.length}</span>
            </div>
            {loadingList && (
              <div className="text-[12px] text-ink-300 italic font-display py-4 text-center">{t('invite.loading')}</div>
            )}
            {!loadingList && activeInvitations.length === 0 && (
              <div className="text-[12.5px] text-ink-400 italic font-display py-3">{t('invite.noPending')}</div>
            )}
            <div className="flex flex-col gap-1.5">
              {activeInvitations.map((inv) => (
                <InvitationRow key={inv.id} inv={inv} onRevoke={() => void revoke(inv.id)} />
              ))}
            </div>
            {historicalInvitations.length > 0 && (
              <details className="mt-3">
                <summary className="text-[11.5px] text-ink-400 cursor-pointer font-display italic hover:text-ink-600">
                  {t('invite.showPast', { n: historicalInvitations.length, s: historicalInvitations.length === 1 ? '' : 's' })}
                </summary>
                <div className="flex flex-col gap-1.5 mt-2">
                  {historicalInvitations.map((inv) => (
                    <InvitationRow key={inv.id} inv={inv} historical />
                  ))}
                </div>
              </details>
            )}
            {listErr && (
              <div className="text-[12.5px] text-coral-deep mt-2">{listErr}</div>
            )}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-ink-100 flex items-center gap-2 bg-paper shrink-0">
          <div className="text-[11.5px] text-ink-300 italic font-display">
            {t('invite.expireFootnote')}
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-[9px] text-[12.5px] font-semibold text-ink-700 bg-cloud hover:bg-sky2-50 transition"
            style={{ border: '1px solid var(--ink-100)' }}
          >{t('invite.doneBtn')}</button>
        </div>
      </div>

      <style>{`
        .ip-input {
          width: 100%;
          padding: 8px 12px;
          font-size: 13.5px;
          background: var(--paper);
          border: 1.5px solid var(--ink-100);
          border-radius: 10px;
          outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
          color: var(--ink-900);
        }
        .ip-input:focus {
          border-color: var(--sky2-300);
          box-shadow: 0 0 0 3px var(--sky-50);
        }
      `}</style>
    </div>
  )
}

function CreatedInviteCard({ invite, onDone }: { invite: ApiInvitationWithToken; onDone: () => void }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invite.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* swallow */ }
  }
  const delivery = invite.emailDelivery
  const headline = delivery?.attempted && delivery.ok
    ? t('invite.sentHeadline')
    : t('invite.readyHeadline')
  return (
    <div
      className="rounded-[12px] p-4 space-y-2"
      style={{
        background: 'linear-gradient(135deg, var(--sky-50), var(--paper))',
        border: '1.5px solid var(--sky2-300)',
      }}
    >
      <div className="flex items-center gap-2">
        <span className="w-5 h-5 rounded-full grid place-items-center text-white text-[11px] font-bold"
              style={{ background: 'var(--skype)' }}>✓</span>
        <div className="text-[13px] font-semibold text-ink-900">{headline}</div>
      </div>
      <div className="text-[11.5px] text-ink-500 italic font-display">
        {invite.email
          ? delivery?.attempted && delivery.ok
            ? t('invite.deliveryOk', { email: invite.email })
            : t('invite.deliveryLocked', { email: invite.email })
          : t('invite.deliveryAnyone', { role: invite.role })}
      </div>
      {delivery && delivery.attempted && !delivery.ok && (
        <div className="text-[11.5px] py-1.5 px-2.5 rounded-[8px]"
             style={{ background: 'var(--coral-soft)', color: 'var(--coral-deep)', border: '1px solid var(--coral-deep)' }}>
          {t('invite.deliveryFailed', { err: delivery.error ?? t('invite.deliveryUnknownErr') })}
        </div>
      )}
      {delivery?.skipped === 'no_email_config' && (
        <div className="text-[11.5px] text-ink-500 py-1.5 px-2.5 rounded-[8px]"
             style={{ background: 'var(--cloud)', border: '1px dashed var(--ink-200)' }}>
          {t('invite.noEmailConfig')}
        </div>
      )}
      <div className="flex items-stretch gap-2">
        <input
          readOnly
          value={invite.url}
          className="flex-1 px-3 py-2 text-[12px] rounded-[8px] font-mono"
          style={{ background: 'var(--paper)', border: '1px solid var(--ink-100)', color: 'var(--ink-700)' }}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          onClick={copy}
          className="px-3 py-2 rounded-[8px] text-[12px] font-semibold text-white transition"
          style={{ background: copied ? 'var(--leaf-700, #2d8c72)' : 'var(--ink-700)' }}
        >{copied ? t('invite.copiedBtn') : t('invite.copyBtn')}</button>
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onDone}
          className="text-[11.5px] text-ink-400 hover:text-ink-700 transition"
        >{t('invite.dismissBtn')}</button>
      </div>
    </div>
  )
}

function InvitationRow({
  inv,
  onRevoke,
  historical,
}: {
  inv: ApiInvitation
  onRevoke?: () => void
  historical?: boolean
}) {
  const t = useT()
  const expiresDistance = useMemo(() => relativeFrom(inv.expiresAt), [inv.expiresAt])
  const statusLabel: Record<typeof inv.status, { label: string; bg: string; fg: string }> = {
    active:   { label: inv.email ? t('invite.statusAwaiting') : t('invite.statusShareable'), bg: 'var(--sky-50)', fg: 'var(--sky2-700, #2466a5)' },
    revoked:  { label: t('invite.statusRevoked'), bg: 'var(--cloud)', fg: 'var(--ink-400)' },
    expired:  { label: t('invite.statusExpired'), bg: 'var(--cloud)', fg: 'var(--ink-400)' },
    consumed: { label: t('invite.statusUsed'),    bg: 'var(--cloud)', fg: 'var(--ink-400)' },
  }
  const pill = statusLabel[inv.status]
  return (
    <div
      className="rounded-[10px] p-2.5 flex items-center gap-3"
      style={{ background: 'var(--paper)', border: '1px solid var(--ink-100)', opacity: historical ? 0.7 : 1 }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="text-[13px] font-semibold text-ink-900 truncate">
            {inv.email ?? <span className="text-ink-500 italic font-display">{t('invite.shareableLabel')}</span>}
          </div>
          <span
            className="px-1.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider"
            style={{ background: pill.bg, color: pill.fg }}
          >{pill.label}</span>
          <span className="text-[10.5px] text-ink-400 uppercase tracking-wider font-bold">{inv.role}</span>
        </div>
        <div className="text-[11px] text-ink-400 mt-0.5 font-display italic flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          {!inv.email && (
            <span>{t('invite.useCount', { used: inv.useCount, max: inv.maxUses })}</span>
          )}
          {inv.status === 'active' && <span>{t('invite.expiresIn', { when: expiresDistance })}</span>}
          {inv.status === 'consumed' && inv.lastAcceptedAt && (
            <span>{t('invite.lastAccepted', { when: relativeFrom(inv.lastAcceptedAt) })}</span>
          )}
          {inv.note && <span>· {inv.note}</span>}
        </div>
      </div>
      {inv.status === 'active' && !historical && onRevoke && (
        <div className="flex items-center gap-1.5">
          <CopyLinkButton inviteId={inv.id} />
          <button
            type="button"
            onClick={onRevoke}
            className="px-2 py-1.5 text-[11.5px] font-semibold rounded-[8px] transition"
            style={{ color: 'var(--coral-deep)', border: '1px solid var(--ink-100)' }}
          >{t('invite.revokeBtn')}</button>
        </div>
      )}
    </div>
  )
}

/** The raw token is only ever returned from the create endpoint. After
 *  that the list endpoint only echoes the hash, so we can't show a
 *  copy-able URL for previously-issued invites — instead this button
 *  copies the invite's hash id as a debugging hint. (UX-wise we accept
 *  this limitation; the alternative is keeping plaintext tokens in DB,
 *  which we will not.) */
function CopyLinkButton({ inviteId }: { inviteId: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(inviteId)
      setCopied(true); setTimeout(() => setCopied(false), 1200)
    } catch { /* swallow */ }
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={t('invite.copyRefTitle')}
      className="px-2 py-1.5 text-[11.5px] font-semibold rounded-[8px] transition"
      style={{ color: 'var(--ink-500)', border: '1px solid var(--ink-100)' }}
    >{copied ? t('invite.copiedBtn') : t('invite.copyRefBtn')}</button>
  )
}

function relativeFrom(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  const abs = Math.abs(ms)
  const past = ms < 0
  const minute = 60_000, hour = 60 * minute, day = 24 * hour
  const fmt = (n: number, unit: string) => `${n}${unit}${past ? ' ago' : ''}`
  if (abs < hour) return fmt(Math.max(1, Math.round(abs / minute)), 'm')
  if (abs < day) return fmt(Math.round(abs / hour), 'h')
  if (abs < 7 * day) return fmt(Math.round(abs / day), 'd')
  const w = Math.round(abs / (7 * day))
  return fmt(w, 'w')
}

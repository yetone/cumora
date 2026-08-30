import { useEffect, useMemo, useState } from 'react'
import { api, type ShippingFeatureDetail, type ShippingFeatureStatus, type ShippingRelease, type ShippingVerification } from '@/api/client'
import { useShipping } from '@/stores/shipping'
import { useParticipants } from '@/stores/participants'
import { IBack, IPlus, IShip } from '@/components/icons'
import { Select } from '@/components/Select'
import { cn } from '@/lib/utils'
import { posthog } from '@/lib/observability'
import { useT, type MessageKey } from '@/lib/i18n'

const STATUS_LABEL_KEY: Record<ShippingFeatureStatus, MessageKey> = {
  draft: 'ship.statusDraft',
  contract: 'ship.statusContract',
  building: 'ship.statusBuilding',
  verifying: 'ship.statusVerifying',
  ready: 'ship.statusReady',
  releasing: 'ship.statusReleasing',
  watching: 'ship.statusWatching',
  learned: 'ship.statusLearned',
  paused: 'ship.statusPaused',
  archived: 'ship.statusArchived',
}

const NEXT_STATUS: Partial<Record<ShippingFeatureStatus, ShippingFeatureStatus>> = {
  draft: 'contract', contract: 'building', building: 'verifying', verifying: 'ready',
  ready: 'releasing', releasing: 'watching', watching: 'learned', learned: 'building',
}

function event(name: string, properties?: Record<string, unknown>) {
  try { posthog.capture(name, properties) } catch { /* analytics never blocks shipping */ }
}

/** Store mutations already surface failures in the workspace alert. Event
 * handlers still need to consume rejected promises so React never produces an
 * unhandled rejection, and analytics should only record completed actions. */
function runAction(promise: Promise<unknown>, onSuccess?: () => void) {
  void promise.then(onSuccess).catch(() => { /* error is rendered by the store */ })
}

function fieldClass() {
  return 'w-full rounded-xl border border-ink-100 bg-cloud px-3 py-2.5 text-[13px] text-ink-900 outline-none transition focus:border-skype focus:ring-4 focus:ring-sky2-100'
}

function Button({ children, onClick, disabled, tone = 'default', type = 'button', className }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean; tone?: 'default' | 'primary' | 'danger' | 'success'; type?: 'button' | 'submit'; className?: string
}) {
  const tones = {
    default: 'border-ink-100 bg-cloud text-ink-700 hover:bg-sky2-50',
    primary: 'border-skype bg-skype text-white hover:bg-skype-deep',
    danger: 'border-coral/30 bg-coral-soft/30 text-coral-deep hover:bg-coral-soft/60',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
  }
  return <button type={type} onClick={onClick} disabled={disabled} className={cn('rounded-lg border px-3 py-2 text-[12px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-45', tones[tone], className)}>{children}</button>
}

function Pill({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'good' | 'bad' | 'warn' | 'blue' }) {
  const colors = {
    neutral: 'bg-ink-50 text-ink-600', good: 'bg-emerald-50 text-emerald-700',
    bad: 'bg-coral-soft/40 text-coral-deep', warn: 'bg-gold/15 text-amber-700', blue: 'bg-sky2-50 text-skype-deep',
  }
  return <span className={cn('inline-flex rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[.08em]', colors[tone])}>{children}</span>
}

function featureProgress(feature: { requiredSquares: number; passedSquares: number }) {
  return feature.requiredSquares ? Math.round(feature.passedSquares / feature.requiredSquares * 100) : 0
}

export function ShippingWorkspace({ compact = false }: { compact?: boolean }) {
  const t = useT()
  const overview = useShipping((s) => s.overview)
  const selectedId = useShipping((s) => s.selectedId)
  const detail = useShipping((s) => s.selectedId ? s.details[s.selectedId] : undefined)
  const loading = useShipping((s) => s.loadingOverview)
  const loadingFeatureId = useShipping((s) => s.loadingFeatureId)
  const error = useShipping((s) => s.error)
  const load = useShipping((s) => s.load)
  const select = useShipping((s) => s.select)
  const [creating, setCreating] = useState(false)

  useEffect(() => { void load() }, [load])

  if (loading && !overview) return <Centered title={t('ship.loading')} />
  if (!overview) return <Centered title={t('ship.unavailable')} detail={error ?? undefined} retry={() => void load(true)} />

  const showList = !compact || !selectedId
  const showDetail = !compact || Boolean(selectedId)
  const dueReadbacks = overview.dueReadbacks.length
  return (
    <div className={cn('ship-workspace h-full min-h-0 bg-[var(--ship-canvas)]', compact ? 'relative overflow-hidden' : 'grid grid-cols-[300px_minmax(0,1fr)]')}>
      {showList && (
        <aside className={cn('h-full overflow-y-auto border-r border-ink-100 bg-cloud', compact && 'absolute inset-0 border-r-0')}>
          <div className="sticky top-0 z-10 border-b border-ink-100 bg-cloud/95 px-4 py-4 backdrop-blur">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-[18px] font-semibold text-ink-900">{t('nav.ship')}</h1>
                <p className="mt-0.5 text-[11px] text-ink-400">{t('ship.subtitle')}</p>
              </div>
              <button type="button" onClick={() => setCreating(true)} className="grid h-9 w-9 place-items-center rounded-xl bg-skype text-white shadow-soft" aria-label={t('ship.newFeature')} title={t('ship.newFeatureTitle')}><IPlus className="h-4 w-4" /></button>
            </div>
          </div>
          {creating && <CreateFeature onClose={() => setCreating(false)} />}
          {dueReadbacks > 0 && (
            <div className="mx-3 mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
              <div className="text-[11px] font-bold text-amber-800">{t('ship.readbacksDue', { n: dueReadbacks, plural: dueReadbacks === 1 ? '' : 's' })}</div>
              <div className="mt-1 text-[10px] text-amber-700">{t('ship.readbacksDueHint')}</div>
            </div>
          )}
          <div className="p-2">
            {overview.features.map((feature) => {
              const progress = featureProgress(feature)
              return (
                <button type="button" key={feature.id} onClick={() => void select(feature.id)} className={cn('mb-1 w-full rounded-xl px-3 py-3 text-left transition', selectedId === feature.id ? 'bg-sky2-50 ring-1 ring-sky2-200' : 'hover:bg-ink-50')}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 truncate text-[13px] font-semibold text-ink-900">{feature.title}</span>
                    <Pill tone={feature.failedSquares ? 'bad' : feature.status === 'learned' ? 'good' : 'blue'}>{t(STATUS_LABEL_KEY[feature.status])}</Pill>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-100"><div className="h-full rounded-full bg-skype transition-all" style={{ width: `${progress}%` }} /></div>
                  <div className="mt-1.5 flex justify-between text-[10px] text-ink-400"><span>{t('ship.requiredSquares', { passed: feature.passedSquares, required: feature.requiredSquares })}</span><span>{t('ship.riskLabel', { risk: feature.riskLevel })}</span></div>
                </button>
              )
            })}
            {overview.features.length === 0 && (
              <div className="px-6 py-16 text-center"><IShip className="mx-auto h-9 w-9 text-ink-300" /><div className="mt-3 text-[13px] font-semibold text-ink-700">{t('ship.empty')}</div><p className="mt-1 text-[11px] leading-relaxed text-ink-400">{t('ship.emptyDetail')}</p></div>
            )}
          </div>
        </aside>
      )}
      {showDetail && (
        <main className={cn('h-full min-w-0 overflow-y-auto bg-[var(--ship-canvas)]', compact && 'absolute inset-0')}>
          {compact && <button type="button" onClick={() => void select(null)} className="sticky top-0 z-20 flex h-11 w-full items-center gap-1 border-b border-ink-100 bg-cloud/95 px-3 text-[12px] font-semibold text-skype-deep backdrop-blur"><IBack className="h-4 w-4" /> {t('ship.allFeatures')}</button>}
          {loadingFeatureId === selectedId && !detail ? <Centered title={t('ship.openingContract')} /> : detail ? <FeatureDetail feature={detail} /> : <Centered title={t('ship.pickOne')} />}
        </main>
      )}
    </div>
  )
}

function Centered({ title, detail, retry }: { title: string; detail?: string; retry?: () => void }) {
  const t = useT()
  return <div className="grid h-full place-items-center p-8 text-center"><div><IShip className="mx-auto h-10 w-10 text-ink-300" /><div className="mt-3 text-[13px] font-semibold text-ink-700">{title}</div>{detail && <p className="mt-2 max-w-md text-[11px] text-coral-deep">{detail}</p>}{retry && <Button onClick={retry} className="mt-3">{t('ship.retry')}</Button>}</div></div>
}

function CreateFeature({ onClose }: { onClose: () => void }) {
  const t = useT()
  const create = useShipping((s) => s.createFeature)
  const saving = useShipping((s) => s.saving)
  const byId = useParticipants((s) => s.byId)
  const participants = useMemo(() => Object.values(byId).filter((p) => !p.departedAt), [byId])
  const [form, setForm] = useState({ title: '', problem: '', desiredOutcome: '', contractSummary: '', builderIds: [] as string[] })
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.title.trim()) return
    try {
      await create(form)
      event('shipping_feature_created', { builder_count: form.builderIds.length })
      onClose()
    } catch { /* the store keeps the form open and renders the API error */ }
  }
  return <form onSubmit={(e) => void submit(e)} className="m-3 rounded-2xl border border-sky2-200 bg-sky2-50/60 p-3 shadow-soft">
    <div className="text-[12px] font-bold text-ink-800">{t('ship.newContract')}</div>
    <input className={cn(fieldClass(), 'mt-2')} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t('ship.fieldTitle')} autoFocus />
    <textarea className={cn(fieldClass(), 'mt-2 min-h-16')} value={form.problem} onChange={(e) => setForm({ ...form, problem: e.target.value })} placeholder={t('ship.fieldProblem')} />
    <textarea className={cn(fieldClass(), 'mt-2 min-h-16')} value={form.desiredOutcome} onChange={(e) => setForm({ ...form, desiredOutcome: e.target.value })} placeholder={t('ship.fieldOutcome')} />
    <textarea className={cn(fieldClass(), 'mt-2 min-h-16')} value={form.contractSummary} onChange={(e) => setForm({ ...form, contractSummary: e.target.value })} placeholder={t('ship.fieldScope')} />
    <div className="mt-2 text-[10px] font-bold uppercase tracking-wide text-ink-400">{t('ship.builders')}</div>
    <div className="mt-1 max-h-28 overflow-auto rounded-xl border border-ink-100 bg-cloud p-2">
      {participants.map((p) => <label key={p.id} className="flex items-center gap-2 py-1 text-[11px] text-ink-700"><input type="checkbox" checked={form.builderIds.includes(p.id)} onChange={(e) => setForm({ ...form, builderIds: e.target.checked ? [...form.builderIds, p.id] : form.builderIds.filter((id) => id !== p.id) })} /> {p.name} <span className="text-ink-400">@{p.id}</span></label>)}
    </div>
    <div className="mt-3 flex justify-end gap-2"><Button onClick={onClose}>{t('common.cancel')}</Button><Button type="submit" tone="primary" disabled={saving || !form.title.trim()}>{t('ship.createContract')}</Button></div>
  </form>
}

function FeatureDetail({ feature }: { feature: ShippingFeatureDetail }) {
  const t = useT()
  const transition = useShipping((s) => s.transition)
  const saving = useShipping((s) => s.saving)
  const error = useShipping((s) => s.error)
  const next = NEXT_STATUS[feature.status]
  const required = feature.verifications.filter((v) => v.required)
  const passed = required.filter((v) => v.status === 'passed').length
  return <div className="mx-auto min-h-full max-w-[1100px] px-4 py-5 md:px-7 md:py-7">
    <header className="rounded-2xl border border-ink-100 bg-cloud p-5 shadow-soft">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Pill tone="blue">{t(STATUS_LABEL_KEY[feature.status])}</Pill><Pill tone={feature.riskLevel === 'critical' || feature.riskLevel === 'high' ? 'warn' : 'neutral'}>{t('ship.riskLabel', { risk: feature.riskLevel })}</Pill></div><h1 className="mt-2 text-[22px] font-semibold tracking-tight text-ink-900">{feature.title}</h1><p className="mt-1 text-[11px] text-ink-400">{t('ship.evidenceProgress', { passed, required: required.length, time: new Date(feature.updatedAt).toLocaleString() })}</p></div>
        {next && feature.status !== 'ready' && feature.status !== 'releasing' && <Button tone="primary" disabled={saving} onClick={() => runAction(transition(next), () => event('shipping_feature_transitioned', { from: feature.status, to: next }))}>{t('ship.moveTo', { next: t(STATUS_LABEL_KEY[next]) })}</Button>}
      </div>
      {error && <div role="alert" className="mt-3 rounded-xl border border-coral/20 bg-coral-soft/20 px-3 py-2 text-[11px] text-coral-deep">{error}</div>}
    </header>
    <ContractSection feature={feature} />
    <InvariantsSection feature={feature} />
    <VerificationsSection feature={feature} />
    <ReleaseSection feature={feature} />
    <LearningSection feature={feature} />
  </div>
}

function Section({ title, eyebrow, children, action }: { title: string; eyebrow: string; children: React.ReactNode; action?: React.ReactNode }) {
  return <section className="mt-4 rounded-2xl border border-ink-100 bg-cloud p-4 shadow-soft md:p-5"><div className="mb-4 flex items-start justify-between gap-3"><div><div className="text-[9px] font-bold uppercase tracking-[.18em] text-skype-deep">{eyebrow}</div><h2 className="mt-1 text-[16px] font-semibold text-ink-900">{title}</h2></div>{action}</div>{children}</section>
}

function ContractSection({ feature }: { feature: ShippingFeatureDetail }) {
  const t = useT()
  const update = useShipping((s) => s.updateFeature)
  const saving = useShipping((s) => s.saving)
  const byId = useParticipants((s) => s.byId)
  const participants = useMemo(() => Object.values(byId).filter((p) => !p.departedAt), [byId])
  const [form, setForm] = useState({ title: feature.title, problem: feature.problem, desiredOutcome: feature.desiredOutcome, contractSummary: feature.contractSummary, builderIds: feature.builderIds, priority: feature.priority, riskLevel: feature.riskLevel, releaseTarget: feature.releaseTarget ?? '' })
  useEffect(() => setForm({ title: feature.title, problem: feature.problem, desiredOutcome: feature.desiredOutcome, contractSummary: feature.contractSummary, builderIds: feature.builderIds, priority: feature.priority, riskLevel: feature.riskLevel, releaseTarget: feature.releaseTarget ?? '' }), [feature])
  return <Section eyebrow={t('ship.sectionDefine')} title={t('ship.contractTitle')} action={<Button tone="primary" disabled={saving} onClick={() => runAction(update(form), () => event('shipping_contract_saved'))}>{t('ship.saveContract')}</Button>}>
    <div className="grid gap-3 md:grid-cols-2"><label className="text-[11px] font-semibold text-ink-700">{t('ship.labelTitle')}<input className={cn(fieldClass(), 'mt-1')} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label><label className="text-[11px] font-semibold text-ink-700">{t('ship.labelReleaseTarget')}<input className={cn(fieldClass(), 'mt-1')} value={form.releaseTarget} onChange={(e) => setForm({ ...form, releaseTarget: e.target.value })} placeholder={t('ship.releaseTargetPh')} /></label></div>
    <div className="mt-3 grid gap-3 md:grid-cols-3">{([['ship.labelProblem', 'problem'], ['ship.labelDesiredOutcome', 'desiredOutcome'], ['ship.labelScopeConstraints', 'contractSummary']] as const).map(([labelKey, key]) => <label key={key} className="text-[11px] font-semibold text-ink-700">{t(labelKey)}<textarea className={cn(fieldClass(), 'mt-1 min-h-28 resize-y')} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} /></label>)}</div>
    <div className="mt-3 grid gap-3 md:grid-cols-2"><div><div className="text-[11px] font-semibold text-ink-700">{t('ship.priorityRisk')}</div><div className="mt-1 flex gap-2"><Select className="flex-1" value={form.priority} onValueChange={(value) => setForm({ ...form, priority: value })} options={(['critical','high','medium','low'] as const).map((v) => ({ value: v, label: v }))} /><Select className="flex-1" value={form.riskLevel} onValueChange={(value) => setForm({ ...form, riskLevel: value })} options={(['critical','high','medium','low'] as const).map((v) => ({ value: v, label: v }))} /></div></div><div><div className="text-[11px] font-semibold text-ink-700">{t('ship.buildersCantVerify')}</div><div className="mt-1 max-h-24 overflow-auto rounded-xl border border-ink-100 bg-cloud p-2">{participants.map((p) => <label key={p.id} className="mr-3 inline-flex items-center gap-1.5 py-1 text-[11px]"><input type="checkbox" checked={form.builderIds.includes(p.id)} onChange={(e) => setForm({ ...form, builderIds: e.target.checked ? [...form.builderIds, p.id] : form.builderIds.filter((id) => id !== p.id) })} />{p.name}</label>)}</div></div></div>
  </Section>
}

function InvariantsSection({ feature }: { feature: ShippingFeatureDetail }) {
  const t = useT()
  const mutate = useShipping((s) => s.mutateSelected)
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState('behavior')
  return <Section eyebrow={t('ship.sectionConstrain')} title={t('ship.invariantsTitle')} action={<div className="text-[10px] text-ink-400">{t('ship.whatMustRemain')}</div>}>
    <div className="grid gap-2 md:grid-cols-2">{feature.invariants.map((i) => <div key={i.id} className="rounded-xl border border-ink-100 bg-[var(--ship-face)] p-3"><div className="flex items-center justify-between gap-2"><div className="text-[12px] font-semibold text-ink-800">{i.title}</div><Pill tone={i.required ? 'warn' : 'neutral'}>{i.kind}</Pill></div>{i.description && <p className="mt-1 text-[11px] leading-relaxed text-ink-500">{i.description}</p>}</div>)}</div>
    <form className="mt-3 flex flex-col gap-2 md:flex-row" onSubmit={(e) => { e.preventDefault(); if (!title.trim()) return; runAction(mutate((id) => api.createShippingInvariant(id, { title, kind })), () => { setTitle(''); event('shipping_invariant_created', { kind }) }) }}><input className={cn(fieldClass(), 'flex-1')} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('ship.addInvariantPh')} /><Select className="md:w-40" value={kind} onValueChange={setKind} options={(['behavior','architecture','data','security','performance','ux','operability'] as const).map((v) => ({ value: v, label: v }))} /><Button type="submit" disabled={!title.trim()}><IPlus className="mr-1 inline h-3 w-3" /> {t('ship.addBtn')}</Button></form>
  </Section>
}

function VerificationsSection({ feature }: { feature: ShippingFeatureDetail }) {
  const t = useT()
  const mutate = useShipping((s) => s.mutateSelected)
  const [title, setTitle] = useState('')
  const [method, setMethod] = useState('property')
  return <Section eyebrow={t('ship.sectionVerify')} title={t('ship.verificationsTitle')} action={<div className="text-[10px] text-ink-400">{t('ship.builderNotVerifier')}</div>}>
    <div className="space-y-2">{feature.verifications.map((square) => <VerificationCard key={square.id} feature={feature} square={square} />)}</div>
    <form className="mt-3 flex flex-col gap-2 md:flex-row" onSubmit={(e) => { e.preventDefault(); if (!title.trim()) return; runAction(mutate((id) => api.createShippingVerification(id, { title, method })), () => { setTitle(''); event('shipping_square_created', { method }) }) }}><input className={cn(fieldClass(), 'flex-1')} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('ship.addVerificationPh')} /><Select className="md:w-48" value={method} onValueChange={setMethod} options={(['user_path','property','trace','data_reconciliation','design_qa','security','performance','release_note'] as const).map((v) => ({ value: v, label: v.replaceAll('_', ' ') }))} /><Button type="submit" disabled={!title.trim()}>{t('ship.addSquareBtn')}</Button></form>
  </Section>
}

function VerificationCard({ feature, square }: { feature: ShippingFeatureDetail; square: ShippingVerification }) {
  const t = useT()
  const mutate = useShipping((s) => s.mutateSelected)
  const byId = useParticipants((s) => s.byId)
  const participants = useMemo(() => Object.values(byId).filter((p) => !p.departedAt && !square.builderIds.includes(p.id)), [byId, square.builderIds])
  const [ownerId, setOwnerId] = useState(square.ownerId ?? '')
  const [evidence, setEvidence] = useState('')
  const [notes, setNotes] = useState(square.notes ?? '')
  useEffect(() => { setOwnerId(square.ownerId ?? ''); setNotes(square.notes ?? '') }, [square.ownerId, square.notes])
  const patch = (status?: string) => mutate((id) => api.updateShippingVerification(id, square.id, {
    ownerId: ownerId || null,
    ...(status ? { status } : {}),
    ...(evidence.trim() ? { evidence: [{ note: evidence.trim(), capturedAt: new Date().toISOString() }] } : {}),
    ...(notes.trim() ? { notes: notes.trim() } : {}),
  }))
  const tone = square.status === 'passed' ? 'good' : square.status === 'failed' ? 'bad' : square.status === 'running' ? 'blue' : square.status === 'waived' ? 'warn' : 'neutral'
  return <details className="group rounded-xl border border-ink-100 bg-[var(--ship-face)]" open={square.status === 'failed'}><summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-3"><span className={cn('grid h-6 w-6 place-items-center rounded-full border text-[11px] font-bold', square.status === 'passed' ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : square.status === 'failed' ? 'border-coral/30 bg-coral-soft text-coral-deep' : 'border-ink-200 bg-cloud text-ink-400')}>{square.status === 'passed' ? '✓' : square.status === 'failed' ? '!' : '·'}</span><div className="min-w-0 flex-1"><div className="truncate text-[12px] font-semibold text-ink-800">{square.title}</div><div className="mt-0.5 text-[10px] text-ink-400">{square.method.replaceAll('_', ' ')} · {square.required ? t('common.required') : t('common.optional')} · {square.ownerId ? `owner @${square.ownerId}` : t('common.unassigned')}</div></div><Pill tone={tone}>{square.status}</Pill></summary><div className="border-t border-ink-100 px-3 py-3"><div className="grid gap-2 md:grid-cols-[220px_1fr]"><div><div className="text-[10px] font-bold uppercase tracking-wide text-ink-400">{t('ship.independentOwner')}</div><Select className="mt-1" value={ownerId} onValueChange={setOwnerId} ariaLabel={t('ship.independentOwner')} options={[{ value: '', label: t('common.unassigned') }, ...participants.map((p) => ({ value: p.id, label: p.name, hint: `@${p.id}` }))]} /></div><label className="text-[10px] font-bold uppercase tracking-wide text-ink-400">{t('ship.evidenceLabel')}<input className={cn(fieldClass(), 'mt-1')} value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder={t('ship.evidencePh')} /></label></div><label className="mt-2 block text-[10px] font-bold uppercase tracking-wide text-ink-400">{t('ship.notesLabel')}<input className={cn(fieldClass(), 'mt-1')} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('ship.notesPh')} /></label><div className="mt-3 flex flex-wrap gap-2"><Button onClick={() => runAction(patch())}>{t('ship.saveOwner')}</Button><Button tone="primary" onClick={() => runAction(patch('running'))}>{t('ship.start')}</Button><Button tone="success" disabled={!evidence.trim()} onClick={() => runAction(patch('passed'), () => event('shipping_square_completed', { method: square.method, result: 'passed' }))}>{t('ship.passEvidence')}</Button><Button tone="danger" disabled={!evidence.trim()} onClick={() => runAction(patch('failed'), () => event('shipping_square_completed', { method: square.method, result: 'failed' }))}>{t('ship.failEvidence')}</Button><Button disabled={!notes.trim()} onClick={() => runAction(patch('waived'))}>{t('ship.waive')}</Button></div>{square.evidence.length > 0 && <pre className="mt-3 max-h-28 overflow-auto rounded-lg bg-ink-900 p-2 text-[10px] text-white/80">{JSON.stringify(square.evidence, null, 2)}</pre>}</div></details>
}

function ReleaseSection({ feature }: { feature: ShippingFeatureDetail }) {
  const t = useT()
  const mutate = useShipping((s) => s.mutateSelected)
  const [show, setShow] = useState(false)
  const [form, setForm] = useState({ environment: 'staging', version: '', commitSha: '', releaseNotes: '', rollbackPlan: '', baseline: '' })
  const create = async () => {
    await mutate((id) => api.createShippingRelease(id, { ...form, baseline: form.baseline.trim() ? [{ metric: form.baseline.trim(), capturedAt: new Date().toISOString() }] : [] }))
    event('shipping_release_planned', { environment: form.environment })
    setShow(false)
  }
  return <Section eyebrow={t('ship.sectionRelease')} title={t('ship.releaseSectionTitle')} action={<Button onClick={() => setShow((v) => !v)}>{show ? t('ship.closePlanner') : t('ship.planRelease')}</Button>}>
    {show && <div className="mb-4 rounded-xl border border-sky2-200 bg-sky2-50/50 p-3"><div className="grid gap-2 md:grid-cols-3"><Select value={form.environment} onValueChange={(value) => setForm({ ...form, environment: value })} options={(['staging','canary','production'] as const).map((v) => ({ value: v, label: v }))} /><input className={fieldClass()} value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} placeholder={t('ship.versionPh')} /><input className={fieldClass()} value={form.commitSha} onChange={(e) => setForm({ ...form, commitSha: e.target.value })} placeholder={t('ship.commitShaPh')} /></div><textarea className={cn(fieldClass(), 'mt-2 min-h-20')} value={form.releaseNotes} onChange={(e) => setForm({ ...form, releaseNotes: e.target.value })} placeholder={t('ship.releaseNotesPh')} /><textarea className={cn(fieldClass(), 'mt-2 min-h-20')} value={form.rollbackPlan} onChange={(e) => setForm({ ...form, rollbackPlan: e.target.value })} placeholder={t('ship.rollbackPlanPh')} /><input className={cn(fieldClass(), 'mt-2')} value={form.baseline} onChange={(e) => setForm({ ...form, baseline: e.target.value })} placeholder={t('ship.baselinePh')} /><div className="mt-2 flex justify-end"><Button tone="primary" onClick={() => runAction(create())}>{t('ship.createReleaseGate')}</Button></div></div>}
    <div className="space-y-2">{feature.releases.map((release) => <ReleaseCard key={release.id} featureId={feature.id} release={release} />)}{feature.releases.length === 0 && <p className="text-[11px] text-ink-400">{t('ship.noReleasesYet')}</p>}</div>
  </Section>
}

function ReleaseCard({ featureId, release }: { featureId: string; release: ShippingRelease }) {
  const t = useT()
  const mutate = useShipping((s) => s.mutateSelected)
  const [evidence, setEvidence] = useState('')
  const action = async (name: string) => {
    const needsEvidence = ['succeed', 'fail', 'readback_pass', 'readback_fail'].includes(name)
    await mutate(() => api.shippingReleaseAction(featureId, release.id, { action: name, ...(needsEvidence ? { evidence: [{ note: evidence.trim(), capturedAt: new Date().toISOString() }] } : {}), ...(name === 'rollback' ? { reason: evidence.trim() } : {}) }))
    event('shipping_release_action', { environment: release.environment, action: name })
    setEvidence('')
  }
  const actions = release.status === 'planned' ? ['approve'] : release.status === 'approved' ? ['start'] : release.status === 'running' ? ['succeed','fail'] : release.status === 'succeeded' && release.environment === 'production' && ['pending','overdue'].includes(release.readbackStatus) ? ['readback_pass','readback_fail','rollback'] : release.status === 'succeeded' ? ['rollback'] : []
  return <details className="rounded-xl border border-ink-100 bg-[var(--ship-face)]"><summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-3"><Pill tone={release.status === 'succeeded' ? 'good' : release.status === 'failed' || release.status === 'rolled_back' ? 'bad' : release.status === 'running' ? 'blue' : 'warn'}>{release.environment}</Pill><div className="min-w-0 flex-1"><div className="text-[12px] font-semibold text-ink-800">{release.version || release.commitSha || t('ship.unversioned')}</div><div className="mt-0.5 text-[10px] text-ink-400">{release.status} · readback {release.readbackStatus}{release.readbackDueAt ? ` · due ${new Date(release.readbackDueAt).toLocaleString()}` : ''}</div></div></summary><div className="border-t border-ink-100 p-3"><div className="grid gap-2 text-[11px] text-ink-600 md:grid-cols-2"><div><b>{t('ship.releaseNotesLabel')}</b><p className="mt-1 whitespace-pre-wrap">{release.releaseNotes || '—'}</p></div><div><b>{t('ship.rollbackPlanLabel')}</b><p className="mt-1 whitespace-pre-wrap">{release.rollbackPlan || '—'}</p></div></div>{actions.length > 0 && <><input className={cn(fieldClass(), 'mt-3')} value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder={actions.includes('approve') || actions.includes('start') ? t('ship.optionalNote') : t('ship.smokeEvidence')} /><div className="mt-2 flex flex-wrap gap-2">{actions.map((name) => <Button key={name} tone={name.includes('fail') || name === 'rollback' ? 'danger' : name.includes('pass') || name === 'succeed' ? 'success' : 'primary'} disabled={['succeed','fail','readback_pass','readback_fail','rollback'].includes(name) && !evidence.trim()} onClick={() => runAction(action(name))}>{name.replaceAll('_', ' ')}</Button>)}</div></>}</div></details>
}

function LearningSection({ feature }: { feature: ShippingFeatureDetail }) {
  const t = useT()
  const mutate = useShipping((s) => s.mutateSelected)
  const [friction, setFriction] = useState('')
  const [regression, setRegression] = useState('')
  const resolveFriction = (id: string) => mutate(async (featureId) => {
    await api.updateShippingFriction(id, { status: 'resolved' })
    return api.getShippingFeature(featureId)
  })
  const captureFriction = () => mutate(async (featureId) => {
    await api.createShippingFriction({ featureId, title: friction, description: friction, frequency: 'once' })
    return api.getShippingFeature(featureId)
  })
  return <Section eyebrow={t('ship.sectionLearn')} title={t('ship.frictionMemory')}>
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <div className="text-[11px] font-bold text-ink-700">{t('ship.frictionInbox')}</div>
        <div className="mt-2 space-y-2">
          {feature.frictions.map((item) => <div key={item.id} className="rounded-xl border border-ink-100 p-3">
            <div className="flex justify-between gap-2"><span className="text-[11px] font-semibold text-ink-800">{item.title}</span><Pill tone={item.severity === 'critical' || item.severity === 'high' ? 'bad' : 'warn'}>{item.occurrenceCount}× {item.status}</Pill></div>
            <p className="mt-1 text-[10px] text-ink-500">{item.description}</p>
            {!['resolved','dismissed'].includes(item.status) && <Button className="mt-2" onClick={() => runAction(resolveFriction(item.id))}>{t('ship.resolve')}</Button>}
          </div>)}
        </div>
        <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (!friction.trim()) return; runAction(captureFriction(), () => { setFriction(''); event('shipping_friction_reported') }) }}>
          <input className={fieldClass()} value={friction} onChange={(e) => setFriction(e.target.value)} placeholder={t('ship.frictionPh')} />
          <Button type="submit">{t('ship.capture')}</Button>
        </form>
      </div>
      <div>
        <div className="text-[11px] font-bold text-ink-700">{t('ship.regressionAssets')}</div>
        <div className="mt-2 space-y-2">
          {feature.regressions.map((item) => <div key={item.id} className="rounded-xl border border-ink-100 p-3">
            <div className="flex justify-between gap-2"><span className="text-[11px] font-semibold text-ink-800">{item.title}</span><Pill tone={item.status === 'passing' ? 'good' : item.status === 'failing' ? 'bad' : 'blue'}>{item.kind} · {item.status}</Pill></div>
            {item.command && <code className="mt-2 block overflow-auto rounded-lg bg-ink-900 px-2 py-1.5 text-[10px] text-white/80">{item.command}</code>}
          </div>)}
        </div>
        <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (!regression.trim()) return; runAction(mutate((id) => api.createShippingRegression(id, { title: regression, kind: 'manual_replay', expected: 'Previously verified behavior remains true' })), () => { setRegression(''); event('shipping_regression_created') }) }}>
          <input className={fieldClass()} value={regression} onChange={(e) => setRegression(e.target.value)} placeholder={t('ship.regressionPh')} />
          <Button type="submit">{t('ship.harden')}</Button>
        </form>
      </div>
    </div>
  </Section>
}

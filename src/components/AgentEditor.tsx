import { useEffect, useState } from 'react'
import { api, getPairingServerOrigin, type AgentInput } from '@/api/client'
import { isNativePlatform } from '@/lib/native'
import { useParticipants } from '@/stores/participants'
import { useComputers } from '@/stores/computers'
import { useConversations } from '@/stores/conversations'
import { useAuth } from '@/stores/auth'
import { Input } from '@/components/Input'
import { TextArea } from '@/components/TextArea'
import { Select } from '@/components/Select'
import type { Participant, EngineId } from '@/types'

const PALETTE = [
  '#FFB088', '#FFD9D2', '#FFB7AF', '#F4B740',
  '#7C5CFF', '#A593FF', '#4FC2F4', '#41B5DC',
  '#4FC2A1', '#6EC56A', '#E9A0E9', '#FF7AB6',
]

interface Props {
  /** if provided, edit mode; otherwise create mode */
  agent: Participant | null
  onClose: () => void
}

export function AgentEditor({ agent, onClose }: Props) {
  const editing = agent !== null
  const [name, setName] = useState(agent?.name ?? '')
  const [role, setRole] = useState(agent?.role ?? '')
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? '')
  const [bio, setBio] = useState(agent?.bio ?? '')
  const [avatarBg, setAvatarBg] = useState(agent?.avatarBg ?? PALETTE[0])
  const [model, setModel] = useState(agent?.model ?? '')
  const [fastModel, setFastModel] = useState(agent?.fastModel ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(agent?.avatarUrl ?? null)
  const [generatingAvatar, setGeneratingAvatar] = useState(false)
  const [avatarErr, setAvatarErr] = useState<string | null>(null)
  const [repairCode, setRepairCode] = useState<string | null>(null)
  const [repairErr, setRepairErr] = useState<string | null>(null)
  const [repairCopied, setRepairCopied] = useState(false)

  // "Runs on" — which Computer hosts this agent. Cloud = managed engine.
  // Free tier is BYOA-only: it has no real Cumora Cloud computer; we show a
  // LOCKED "Cumora Cloud (Pro)" upsell instead and never default/select it.
  const activeTier = useAuth((s) => s.companies.find((c) => c.id === s.activeCompanyId)?.tier)
  const isFreeTier = activeTier === 'free'
  const computersById = useComputers((s) => s.byId)
  const computers = Object.values(computersById)
    .sort((a, b) => (a.kind === 'cloud' ? 0 : 1) - (b.kind === 'cloud' ? 0 : 1) || a.name.localeCompare(b.name))
  const cloud = computers.find((c) => c.kind === 'cloud')
  const firstByoa = computers.find((c) => c.kind !== 'cloud')
  // Default for a NEW agent: paid → Cumora Cloud; free → first paired computer.
  const [computerId, setComputerId] = useState(agent?.computerId ?? (isFreeTier ? firstByoa?.id : cloud?.id) ?? '')
  const [engine, setEngine] = useState<EngineId>((agent?.engine as EngineId) ?? 'managed')
  const selectedComputer = computerId ? computersById[computerId] : undefined
  const isByoa = !!selectedComputer && selectedComputer.kind !== 'cloud'
  const selectedComputerOffline = isByoa && selectedComputer.status !== 'online'
  const origin = getPairingServerOrigin()
  const repairCommand = repairCode
    ? `npx cumora@latest agent computer --pair ${repairCode}${origin ? ` --server ${origin}` : ''}`
    : ''

  useEffect(() => { void useComputers.getState().refresh() }, [])
  useEffect(() => {
    setRepairCopied(false)
    setRepairErr(null)
    setRepairCode(null)
    if (!selectedComputerOffline || !selectedComputer) return

    let cancelled = false
    void api.repairComputer(selectedComputer.id)
      .then((out) => { if (!cancelled) setRepairCode(out.code) })
      .catch((e) => {
        if (!cancelled) setRepairErr(e instanceof Error ? e.message : String(e))
      })
    return () => { cancelled = true }
  }, [selectedComputer?.id, selectedComputerOffline])
  useEffect(() => {
    if (!repairCopied) return
    const t = window.setTimeout(() => setRepairCopied(false), 1600)
    return () => window.clearTimeout(t)
  }, [repairCopied])
  // Default selection once the list loads (new agents): paid → Cumora Cloud,
  // free → the first paired computer (never cloud).
  useEffect(() => {
    if (computerId) return
    if (isFreeTier && firstByoa) { setComputerId(firstByoa.id); setEngine((firstByoa.availableEngines[0] as EngineId) ?? 'claude') }
    else if (!isFreeTier && cloud) { setComputerId(cloud.id); setEngine('managed') }
  }, [cloud, firstByoa, computerId, isFreeTier])

  const changeComputer = (id: string): void => {
    setComputerId(id)
    const c = computersById[id]
    if (!c || c.kind === 'cloud') setEngine('managed')
    else setEngine((agent?.engine as EngineId) && c.availableEngines.includes(agent!.engine as EngineId)
      ? (agent!.engine as EngineId)
      : (c.availableEngines[0] ?? 'claude'))
  }

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async () => {
    setErr(null)
    setBusy(true)
    try {
      const payload: AgentInput = { name, role, systemPrompt, bio, avatarBg, model: model.trim() || null, fastModel: fastModel.trim() || null }
      let agentId = agent?.id
      if (editing) {
        // Only send avatarUrl on change so we don't clobber it on no-op edits.
        if ((agent!.avatarUrl ?? null) !== avatarUrl) payload.avatarUrl = avatarUrl
        await api.updateAgent(agent!.id, payload)
      } else {
        // No `id` field on create — server slugifies it from `name`
        // and guarantees global uniqueness.
        const created = await api.createAgent(payload)
        agentId = created.id
      }
      // Persist the host assignment when the computer OR the engine changed.
      // (Engine lives in the same assign call; gating only on the computer
      // would silently drop a Claude→Codex switch on the same machine.) Still
      // skipped on a plain style edit to avoid the owner/admin-gated call.
      const target = computerId || cloud?.id
      const current = agent?.computerId ?? cloud?.id
      const targetComputer = target ? computersById[target] : undefined
      const isByoaTarget = !!targetComputer && targetComputer.kind !== 'cloud'
      const engineChanged = isByoaTarget && engine !== ((agent?.engine as EngineId) ?? null)
      if (agentId && target && (target !== current || engineChanged)) {
        await api.assignAgentComputer(agentId, target, isByoaTarget ? engine : undefined)
      }
      await useParticipants.getState().load()
      await useConversations.getState().reload()
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const initial = (name || agent?.id || '?').charAt(0).toUpperCase()

  const generateAvatar = async () => {
    if (!editing || !agent) return
    setAvatarErr(null)
    setGeneratingAvatar(true)
    try {
      // First save any pending edits so the prompt reflects what the user typed.
      await api.updateAgent(agent.id, { name, role, systemPrompt, bio, avatarBg })
      const r = await api.generateAgentAvatar(agent.id)
      setAvatarUrl(r.url)
      await useParticipants.getState().load()
    } catch (e) {
      setAvatarErr(e instanceof Error ? e.message : String(e))
    } finally {
      setGeneratingAvatar(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-6"
      style={{ background: 'rgba(15, 30, 50, 0.55)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
    >
      <div
        className="bg-cloud rounded-[18px] shadow-pop w-full max-w-[560px] max-h-[90vh] flex flex-col overflow-hidden"
        style={{ border: '1px solid var(--ink-100)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-ink-100 flex items-center gap-3 shrink-0">
          <div
            className="w-12 h-12 rounded-full grid place-items-center text-white font-bold text-[18px] shrink-0 overflow-hidden relative"
            style={{ background: avatarUrl ? 'transparent' : avatarBg }}
          >
            {avatarUrl
              ? <img src={avatarUrl} alt={name || initial} className="absolute inset-0 w-full h-full object-cover" />
              : initial}
          </div>
          <div className="flex-1">
            <h2 className="font-display font-medium text-[20px] tracking-tight">
              {editing ? `Edit ${agent!.name}` : 'New agent'}
            </h2>
            <div className="text-[12.5px] text-ink-500 italic font-display">
              {editing ? 'Tweak how this teammate behaves.' : 'Define a new teammate from scratch.'}
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full grid place-items-center text-ink-500 hover:bg-sky2-50 hover:text-ink-900 transition"
            aria-label="Close"
          >×</button>
        </div>

        <div className="px-6 py-5 space-y-4 overflow-y-auto flex-1 min-h-0">
          <Field label="Name" hint="What teammates call them. The handle (@-mention id) is derived from this automatically.">
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Saga"
            />
          </Field>

          <Field label="Role" hint="One- or two-word title shown next to the name.">
            <Input
              type="text"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. Storyteller"
            />
          </Field>

          <Field label="Style (system prompt)" hint="The agent's voice, instincts, and quirks. Written in second person — the LLM reads this as 'you'.">
            <TextArea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={5}
              placeholder="You write narratives. You sense what the team forgets to say out loud. Direct, warm, never preachy."
              className="font-display italic"
              style={{ minHeight: 110 }}
            />
          </Field>

          <Field label="Bio" hint="Optional, shown on the agent card.">
            <TextArea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              rows={2}
              placeholder="A one-line description of what they're best at."
            />
          </Field>

          <Field
            label={isByoa ? 'Big-brain model (大脑)' : 'Model'}
            hint={isByoa
              ? `Main reasoning model passed to the engine as --model. ${engine === 'codex' ? 'A model name (e.g. gpt-5.5, o3).' : "A Claude alias or full name (e.g. opus, sonnet, claude-sonnet-4-6)."} Blank = engine default.`
              : 'Optional — leave blank to use the system default. Any OpenAI model name works (e.g. gpt-5.5, gpt-5.5-pro, gpt-5.5-mini).'}
          >
            <Input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="(default)"
              className="font-mono"
              spellCheck={false}
            />
          </Field>

          {isByoa && (
            <Field
              label="Small-brain model (小脑)"
              hint={engine === 'codex'
                ? 'Cheaper model for light auxiliary tasks (e.g. gpt-5.4-mini). Blank = same as big-brain.'
                : "Cheaper/faster model for light auxiliary tasks — maps to Claude's ANTHROPIC_SMALL_FAST_MODEL. Blank = engine default."}
            >
              <Input
                type="text"
                value={fastModel}
                onChange={(e) => setFastModel(e.target.value)}
                placeholder="(default)"
                className="font-mono"
                spellCheck={false}
              />
            </Field>
          )}

          <Field
            label="Runs on"
            hint="Which computer executes this agent. Cumora Cloud is managed; a computer you've paired runs it on your local Claude Code or Codex."
          >
            <Select
              ariaLabel="Runs on"
              value={computerId}
              onValueChange={changeComputer}
              options={[
                // Free tier has no real Cumora Cloud computer — filter any out
                // (defensive) and append a locked Pro upsell entry instead.
                // NOT on native: App Store Guideline 3.1.1 forbids referencing
                // a paid tier that isn't purchasable in-app via IAP, so the
                // iOS/Android builds omit the upsell entirely.
                ...computers
                  .filter((c) => !(isFreeTier && c.kind === 'cloud'))
                  .map((c) => ({
                    value: c.id,
                    label: `${c.kind === 'cloud' ? '☁' : c.kind === 'vps' ? '🖥' : '💻'} ${c.name}`
                      + (c.kind !== 'cloud' && c.status !== 'online' ? ' (offline)' : ''),
                  })),
                ...(isFreeTier && !isNativePlatform()
                  ? [{ value: '__cloud_pro__', label: '☁ Cumora Cloud — upgrade to Pro', disabled: true }]
                  : []),
              ]}
            />
            {selectedComputer && selectedComputer.kind !== 'cloud' && (
              <div className="mt-2">
                <Select
                  ariaLabel="Engine"
                  value={engine}
                  onValueChange={(v) => setEngine(v as EngineId)}
                  options={(selectedComputer.availableEngines.length
                    ? selectedComputer.availableEngines
                    : (['claude'] as EngineId[])
                  ).map((en) => ({ value: en, label: en === 'claude' ? 'Claude Code' : en === 'codex' ? 'Codex' : en }))}
                />
              </div>
            )}
            {selectedComputerOffline && (
              <div
                className="mt-3 rounded-[12px] p-3"
                style={{ background: 'var(--sky-50)', border: '1px solid var(--sky-100)' }}
              >
                <div className="text-[12px] font-semibold text-ink-900 mb-1">
                  {selectedComputer?.name} is offline. Run this on that computer:
                </div>
                {repairErr ? (
                  <div className="text-[11.5px] text-coral-deep bg-coral-soft rounded-[8px] p-2">{repairErr}</div>
                ) : repairCommand ? (
                  <>
                    <pre className="bg-ink-900 text-cloud rounded-[9px] p-2.5 text-[11.5px] overflow-x-auto whitespace-pre-wrap break-all font-mono select-all">
                      {repairCommand}
                    </pre>
                    <button
                      type="button"
                      onClick={() => { void navigator.clipboard?.writeText(repairCommand); setRepairCopied(true) }}
                      className="mt-2 inline-flex items-center justify-center min-w-[108px] text-[11.5px] font-semibold px-3 py-1.5 rounded-[9px] text-white transition-colors duration-200"
                      style={{ background: repairCopied ? '#3BB273' : 'var(--skype)' }}
                    >
                      {repairCopied ? '✓ Copied!' : 'Copy command'}
                    </button>
                  </>
                ) : (
                  <div className="text-[11.5px] text-ink-400">Generating reconnect command…</div>
                )}
              </div>
            )}
          </Field>

          <Field label="Avatar color" hint="Used as a fallback when no AI portrait is generated.">
            <div className="flex flex-wrap gap-2">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setAvatarBg(c)}
                  className="w-8 h-8 rounded-full transition"
                  style={{
                    background: c,
                    boxShadow: avatarBg === c
                      ? '0 0 0 3px var(--cloud), 0 0 0 5px var(--skype)'
                      : 'inset 0 0 0 1px rgba(0,0,0,0.06)',
                  }}
                  aria-label={c}
                />
              ))}
            </div>
          </Field>

          <Field
            label="AI-generated portrait"
            hint={editing
              ? 'Generates an editorial portrait fitting this agent\'s name, role, and style. Save your edits first if you tweaked the style.'
              : 'Available after the agent is created. Save first, then re-open to generate.'}
          >
            <div className="flex items-center gap-4">
              {/* Avatar preview with breathing/sparkle animation while generating */}
              <div className="relative shrink-0" style={{ width: 88, height: 88 }}>
                {/* Soft outer glow that breathes */}
                {generatingAvatar && (
                  <div
                    className="absolute rounded-full pointer-events-none"
                    style={{
                      inset: -8,
                      background: 'conic-gradient(from 0deg, #FFB088, #7C5CFF, #4FC2F4, #6EC56A, #FFB088)',
                      filter: 'blur(8px)',
                      opacity: 0.55,
                      animation: 'ae-spin 3s linear infinite, ae-breathe 1.6s ease-in-out infinite',
                    }}
                  />
                )}
                {/* Avatar bubble */}
                <div
                  className="absolute inset-0 rounded-full grid place-items-center text-white font-bold text-[28px]"
                  style={{
                    background: avatarUrl ? 'transparent' : avatarBg,
                    boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.05)',
                    transform: generatingAvatar ? undefined : 'scale(1)',
                    animation: generatingAvatar ? 'ae-pop 1.6s cubic-bezier(.36,1.6,.4,1) infinite' : undefined,
                  }}
                >
                  {avatarUrl
                    ? <img src={avatarUrl} alt={name || initial} className="absolute inset-0 w-full h-full object-cover rounded-full" />
                    : initial}
                  {/* Diagonal shimmer sweep */}
                  {generatingAvatar && (
                    <div
                      className="absolute inset-0 rounded-full pointer-events-none overflow-hidden"
                    >
                      <div
                        className="absolute"
                        style={{
                          inset: '-50%',
                          background: 'linear-gradient(115deg, transparent 35%, rgba(255,255,255,0.55) 50%, transparent 65%)',
                          animation: 'ae-sheen 2.2s cubic-bezier(.4,0,.2,1) infinite',
                        }}
                      />
                    </div>
                  )}
                </div>
                {/* Twinkling sparkles ✦ */}
                {generatingAvatar && (
                  <>
                    <span className="absolute text-whisper select-none pointer-events-none"
                      style={{ top: -2, right: 6, fontSize: 14, animation: 'ae-twinkle 1.4s ease-in-out infinite', animationDelay: '0s' }}>✦</span>
                    <span className="absolute text-skype-deep select-none pointer-events-none"
                      style={{ bottom: 4, left: -4, fontSize: 11, animation: 'ae-twinkle 1.4s ease-in-out infinite', animationDelay: '0.45s' }}>✦</span>
                    <span className="absolute text-gold select-none pointer-events-none"
                      style={{ top: '40%', left: -6, fontSize: 9, animation: 'ae-twinkle 1.4s ease-in-out infinite', animationDelay: '0.9s' }}>✦</span>
                  </>
                )}
              </div>

              <div className="flex-1 flex flex-col gap-2 min-w-0">
                <button
                  type="button"
                  onClick={generateAvatar}
                  disabled={!editing || generatingAvatar}
                  className="self-start inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[10px] text-[12.5px] font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{
                    // Hardcoded purple — this button intentionally keeps the
                    // old AI-portrait accent, decoupled from the whisper
                    // palette which has since moved to sage. Don't switch
                    // back to var(--whisper) here.
                    background: editing
                      ? 'linear-gradient(135deg, #7C5CFF, #4A2D9E)'
                      : 'var(--ink-100)',
                    color: editing ? 'white' : 'var(--ink-500)',
                    boxShadow: editing && !generatingAvatar ? '0 4px 12px -3px rgba(124, 92, 255, 0.45)' : 'none',
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    style={generatingAvatar ? { animation: 'ae-icon-twinkle 1.2s ease-in-out infinite', transformOrigin: 'center' } : undefined}>
                    <path d="M12 2l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/><path d="M19 14l1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/>
                  </svg>
                  {generatingAvatar
                    ? <span>Painting<span className="ae-dots" /></span>
                    : (avatarUrl ? 'Regenerate' : 'Generate with AI')}
                </button>

                {generatingAvatar && (
                  <div className="text-[11.5px] text-whisper-deep font-display italic leading-[1.5]">
                    Composing {name || 'your agent'}'s portrait — usually 15–30s. You can keep editing other fields.
                  </div>
                )}

                {avatarUrl && !generatingAvatar && (
                  <button
                    type="button"
                    onClick={() => setAvatarUrl(null)}
                    className="self-start text-[11.5px] text-ink-500 hover:text-coral-deep transition"
                  >clear portrait (use color block instead)</button>
                )}

                {avatarErr && (
                  <div className="text-[11.5px] text-coral-deep bg-coral-soft py-1.5 px-2 rounded-md leading-[1.4]">
                    {avatarErr}
                  </div>
                )}
              </div>
            </div>
          </Field>

          {err && (
            <div className="text-[12.5px] text-coral-deep bg-coral-soft py-2 px-3 rounded-lg">
              {err}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-ink-100 flex items-center gap-2 bg-paper shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-[9px] text-[12.5px] font-semibold text-ink-700 bg-cloud hover:bg-sky2-50 transition"
            style={{ border: '1px solid var(--ink-100)' }}
          >Cancel</button>
          <div className="flex-1" />
          <button
            onClick={submit}
            disabled={busy || !name.trim() || !systemPrompt.trim()}
            className="px-5 py-2 rounded-[9px] text-[12.5px] font-semibold text-white transition disabled:opacity-50"
            style={{
              background: 'var(--skype)',
              boxShadow: '0 4px 12px -3px rgba(0, 168, 240, 0.5)',
            }}
          >
            {busy ? 'Saving…' : (editing ? 'Save changes' : 'Create agent')}
          </button>
        </div>
      </div>

      <style>{`
        /* === avatar generation animations === */
        @keyframes ae-spin   { to { transform: rotate(360deg); } }
        @keyframes ae-breathe {
          0%, 100% { opacity: 0.45; transform: scale(1); }
          50%      { opacity: 0.75; transform: scale(1.08); }
        }
        @keyframes ae-pop {
          0%, 100% { transform: scale(1); }
          40%      { transform: scale(1.04); }
          70%      { transform: scale(0.985); }
        }
        @keyframes ae-sheen {
          0%   { transform: translateX(-60%) translateY(-60%) rotate(0deg); }
          100% { transform: translateX(60%)  translateY(60%)  rotate(0deg); }
        }
        @keyframes ae-twinkle {
          0%, 100% { opacity: 0.2; transform: scale(0.7); }
          50%      { opacity: 1;   transform: scale(1.15); }
        }
        @keyframes ae-icon-twinkle {
          0%, 100% { opacity: 0.7; transform: scale(0.92); }
          50%      { opacity: 1;   transform: scale(1.08); }
        }
        @keyframes ae-dot {
          0%, 20%  { opacity: 0; }
          50%      { opacity: 1; }
          80%, 100%{ opacity: 0; }
        }
        .ae-dots::after {
          content: '...';
          letter-spacing: 2px;
          display: inline-block;
          margin-left: 2px;
          animation: ae-dot 1.4s steps(4, end) infinite;
        }
      `}</style>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-bold tracking-wider uppercase text-ink-500 mb-1">{label}</label>
      {hint && <div className="text-[11.5px] text-ink-300 mb-1.5 font-display italic">{hint}</div>}
      {children}
    </div>
  )
}

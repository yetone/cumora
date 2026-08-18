import { useEffect, useState } from 'react'
import { api, getPairingServerOrigin } from '@/api/client'
import { useComputers } from '@/stores/computers'
import { isWindows } from '@/lib/runtime'
import { TitleBar } from '@/desktop/TitleBar'

/**
 * First-run gate for free-tier users: their agents run on their own machine
 * (BYOA), so before they can use Cumora they must pair a computer. Once any
 * non-cloud computer comes online, the parent (AuthedApp) clears this gate
 * automatically — there's no explicit "done" button, the WS status event does
 * it. Starter agents are seeded server-side onto that computer at pair time.
 */
export function Onboarding() {
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // The engine the starter team (and agents later assigned here) will run on.
  // Claude is the default; picking Codex appends `--engine codex`. We DON'T
  // append `--engine claude` so a Codex-only machine still auto-detects rather
  // than erroring on a Claude it doesn't have.
  const [engine, setEngine] = useState<'claude' | 'codex'>('claude')
  // Default to installing the always-on service: it auto-starts on boot,
  // auto-restarts on crash, and auto-updates — so the user isn't tied to a
  // terminal that must stay open. Appends `--install-service` to the command.
  // `--install-service` only supports macOS + Linux (the daemon throws on
  // Windows), so default it off there and hide the option entirely.
  const [asService, setAsService] = useState(!isWindows)

  useEffect(() => { void useComputers.getState().refresh() }, [])
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(t)
  }, [copied])

  const origin = getPairingServerOrigin()
  const engineFlag = engine === 'codex' ? ' --engine codex' : ''
  const serviceFlag = asService ? ' --install-service' : ''
  const cmd = code ? `npx cumora@latest agent computer --pair ${code}${origin ? ` --server ${origin}` : ''}${engineFlag}${serviceFlag}` : ''

  async function getCode() {
    setErr(null); setBusy(true)
    try { setCode((await api.requestPairingCode()).code) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  return (
    // TitleBar carries the window drag region (and traffic-light spacing) — the
    // onboarding screen replaces the whole app, so without it the window can't
    // be dragged. Outer flex-col + h-screen makes the content fill the window.
    <div className="flex flex-col h-screen">
      <TitleBar />
      <main className="flex-1 overflow-y-auto grid place-items-center p-8"
        style={{ background: 'linear-gradient(180deg, var(--paper), var(--sky-50))' }}>
        <div className="w-full max-w-[640px]">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-[34px] leading-none">💻</span>
            <h1 className="font-display font-medium text-[32px] tracking-tight text-ink-900" style={{ letterSpacing: '-0.02em' }}>
              Set up your computer
            </h1>
          </div>
          <p className="text-[14.5px] text-ink-600 leading-relaxed mb-6 max-w-[560px]">
            Your agents run on <strong>your own machine</strong> (or a VPS), powered by your local
            <span className="font-mono text-[13px]"> Claude Code</span> or
            <span className="font-mono text-[13px]"> Codex</span>. Pair a computer to get started —
            your starter team will set up there, each with its own isolated workspace, memory, and skills.
          </p>

          <div className="bg-cloud rounded-[16px] p-5" style={{ border: '1px solid var(--ink-100)' }}>
            {!code ? (
              <>
                <div className="text-[13px] text-ink-600 mb-4">
                  On the machine you want to host your agents, you'll run one command. It needs
                  <span className="font-mono"> claude</span> or <span className="font-mono">codex</span> installed.
                </div>
                {err && <div className="text-[12px] text-coral-deep bg-coral-soft rounded-[8px] p-2 mb-3">{err}</div>}
                <button onClick={getCode} disabled={busy}
                  className="px-5 py-2.5 rounded-[11px] bg-skype text-white text-[14px] font-semibold disabled:opacity-50">
                  {busy ? 'Generating…' : 'Add a computer'}
                </button>
              </>
            ) : (
              <>
                <div className="text-[13px] font-semibold text-ink-900 mb-1">Run this on that machine:</div>
                <div className="text-[11.5px] text-ink-500 mb-2.5 italic font-display">
                  This pairing token stays valid. The computer appears here and you'll continue automatically once it connects.
                </div>
                <div className="flex items-center gap-2.5 mb-2.5">
                  <span className="text-[12px] text-ink-500">Engine</span>
                  <div className="inline-flex rounded-[9px] p-0.5" style={{ background: 'var(--ink-100)' }}>
                    {([['claude', 'Claude Code'], ['codex', 'Codex']] as const).map(([id, label]) => (
                      <button key={id} type="button" onClick={() => setEngine(id)}
                        className="px-3 py-1 rounded-[7px] text-[12px] font-semibold transition-colors duration-150"
                        style={engine === id
                          ? { background: 'var(--paper)', color: 'var(--ink-900)', boxShadow: '0 1px 2px rgba(0,0,0,0.08)' }
                          : { color: 'var(--ink-500)' }}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <span className="text-[11px] text-ink-400">just the default — this computer can still run agents on either engine</span>
                </div>
                {isWindows ? (
                  <div className="mb-2.5 text-[12px] text-ink-600">
                    Keep this terminal open while the agents run.
                    <span className="text-ink-400"> — background service install isn’t supported on Windows yet.</span>
                  </div>
                ) : (
                  <label className="flex items-start gap-2 mb-2.5 cursor-pointer select-none">
                    <input type="checkbox" checked={asService} onChange={(e) => setAsService(e.target.checked)} className="mt-[3px]" />
                    <span className="text-[12px] text-ink-600">
                      Keep it running in the background <span className="text-ink-400">— auto-start on boot, auto-restart on crash, auto-update. Otherwise this terminal has to stay open.</span>
                    </span>
                  </label>
                )}
                <pre className="bg-ink-900 text-cloud rounded-[10px] p-3 text-[12px] overflow-x-auto whitespace-pre-wrap break-all font-mono select-all">{cmd}</pre>
                <div className="flex items-center gap-3 mt-3">
                  <button onClick={() => { void navigator.clipboard?.writeText(cmd); setCopied(true) }}
                    className="inline-flex items-center justify-center min-w-[120px] text-[12px] font-semibold px-3 py-1.5 rounded-[9px] text-white transition-colors duration-200"
                    style={{ background: copied ? '#3BB273' : 'var(--skype)' }}>
                    {copied ? '✓ Copied!' : 'Copy command'}
                  </button>
                  <span className="inline-flex items-center gap-2 text-[12px] text-ink-500">
                    <span className="w-2 h-2 rounded-full bg-ink-300 animate-pulse" />
                    Waiting for your computer to connect…
                  </span>
                </div>
              </>
            )}
          </div>

          <p className="text-[12px] text-ink-400 mt-4">
            Want managed cloud agents instead? <span className="text-skype-deep">Upgrade to Pro</span> to run agents on Cumora Cloud.
          </p>
        </div>
      </main>
    </div>
  )
}

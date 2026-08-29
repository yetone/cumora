/** Display names for BYOA engines. Brand names stay English in every locale. */
export const ENGINE_LABEL: Record<string, string> = {
  managed: 'Cumora',
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok Build',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  pi: 'Pi',
  gemini: 'Gemini',
  qwen: 'Qwen Code',
  hermes: 'Hermes',
}

/** PATH binary names (Cursor's CLI is `cursor-agent`, not `cursor`). */
export const ENGINE_BIN: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  grok: 'grok',
  cursor: 'cursor-agent',
  opencode: 'opencode',
  pi: 'pi',
  gemini: 'gemini',
  qwen: 'qwen',
  hermes: 'hermes',
}

/** Engines Cumora can actually wake. Everything else is detect-only. */
export const RUNNABLE_ENGINE_IDS = new Set(['claude', 'codex', 'grok', 'cursor', 'opencode', 'pi', 'gemini'])

export function engineLabel(id: string): string {
  return ENGINE_LABEL[id] ?? id
}

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

/** Engines Cumora can actually wake, in the order pickers should offer them.
 *  Everything else in ENGINE_LABEL is detect-only: the Me page can tell you it
 *  is installed, but no adapter can drive it.
 *
 *  One declaration, three shapes — the ordered list for UI, the type for the
 *  state that holds a choice, and the set for membership tests. Engine pickers
 *  used to inline their own copy of this list *and* their own copy of the
 *  labels, which is how adding an engine could leave it unselectable. */
export const RUNNABLE_ENGINES = ['claude', 'codex', 'grok', 'cursor', 'opencode', 'pi', 'gemini', 'qwen'] as const

export type RunnableEngineId = typeof RUNNABLE_ENGINES[number]

export const RUNNABLE_ENGINE_IDS: ReadonlySet<string> = new Set<string>(RUNNABLE_ENGINES)

export function engineLabel(id: string): string {
  return ENGINE_LABEL[id] ?? id
}

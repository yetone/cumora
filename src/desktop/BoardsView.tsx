import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useBoards } from '@/stores/boards'
import { useParticipants } from '@/stores/participants'
import { useMe } from '@/stores/auth'
import { AvatarMini } from '@/components/Avatar'
import { BoardLink } from '@/components/BoardLink'
import { CardLink } from '@/components/CardLink'
import { CalendarLink } from '@/components/CalendarLink'
import { DocumentLink } from '@/components/DocumentLink'
import { ResizeHandle } from '@/components/ResizeHandle'
import { Select } from '@/components/Select'
import { useResizableWidth } from '@/lib/useResizableWidth'
import { useT } from '@/lib/i18n'
import { IBoard, IPlus, IAt, ITrash, IMore } from '@/components/icons'
import { cn } from '@/lib/utils'
import type { BoardCard, BoardCardComment, BoardColumn, Participant } from '@/types'

/**
 * Boards view — Kanban for both humans and agents.
 *
 * The same boards/cards an agent manipulates via `cumora board ...` show
 * up here. Card titles, descriptions, and comments accept `@<id>` tokens;
 * mentions get chipped inline and broadcast on the boards channel so the
 * recipient (human or agent) is reachable from anywhere.
 */
export function BoardsView() {
  const list = useBoards((s) => s.list)
  const loadingList = useBoards((s) => s.loadingList)
  const selectedId = useBoards((s) => s.selectedId)
  const loadList = useBoards((s) => s.loadList)
  const selectBoard = useBoards((s) => s.selectBoard)

  useEffect(() => { void loadList() }, [loadList])

  // Auto-pick the first board when one becomes available — matches the
  // conversations pane's behaviour and avoids a perpetual "Pick a board"
  // empty state for users who only have one.
  useEffect(() => {
    if (!selectedId && list.length > 0) selectBoard(list[0].id)
  }, [list, selectedId, selectBoard])

  // Same shape as ConversationsLayout — `minmax(0, 1fr)` is critical:
  // a plain `1fr` track expands to fit its widest child, which would
  // make the canvas's horizontal overflow never trigger.
  const { width, onResizeStart } = useResizableWidth('sidebar:boards', 280, { min: 220, max: 480 })

  return (
    <div
      className="h-full grid"
      style={{ gridTemplateColumns: `${width}px minmax(0, 1fr)` }}
    >
      <BoardsSidebar onResizeStart={onResizeStart} />
      {selectedId
        ? <BoardCanvas boardId={selectedId} />
        : <EmptyBoardsState empty={!loadingList && list.length === 0} />}
    </div>
  )
}

/* ============== Sidebar ============== */

function BoardsSidebar({ onResizeStart }: { onResizeStart: (e: React.MouseEvent) => void }) {
  const t = useT()
  const list = useBoards((s) => s.list)
  const selectedId = useBoards((s) => s.selectedId)
  const selectBoard = useBoards((s) => s.selectBoard)
  const createBoard = useBoards((s) => s.createBoard)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')

  async function submit() {
    const title = draft.trim()
    if (!title) { setCreating(false); return }
    setCreating(false)
    setDraft('')
    try {
      await createBoard(title)
    } catch (e) {
      console.warn('[boards] create failed', e)
    }
  }

  return (
    <aside className="h-full overflow-y-auto border-r border-ink-100 bg-cloud/40 relative">
      <ResizeHandle onMouseDown={onResizeStart} />
      <div className="px-4 py-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-ink-900">{t('boards.title')}</h2>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="w-7 h-7 rounded-md grid place-items-center text-ink-500 hover:bg-ink-50 hover:text-skype-deep"
          title={t('boards.newBoard')}
          aria-label={t('boards.newBoard')}
        >
          <IPlus className="w-4 h-4" />
        </button>
      </div>
      {creating && (
        <div className="px-4 pb-2">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
              if (e.key === 'Escape') { setCreating(false); setDraft('') }
            }}
            onBlur={() => void submit()}
            placeholder={t('boards.boardTitlePlaceholder')}
            className="w-full px-2.5 py-1.5 text-sm rounded-md border border-ink-200 bg-cloud text-ink-900 placeholder:text-ink-300 focus:outline-none focus:border-skype"
          />
        </div>
      )}
      <ul className="pb-4">
        {list.map((b) => {
          const active = b.id === selectedId
          return (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => selectBoard(b.id)}
                className={cn(
                  'w-full text-left px-4 py-2.5 flex items-center gap-2.5 transition-colors',
                  active ? 'bg-skype/10 text-skype-deep' : 'text-ink-700 hover:bg-ink-50',
                )}
              >
                <IBoard className="w-4 h-4 flex-shrink-0" />
                <span className="text-sm truncate">{b.title}</span>
              </button>
            </li>
          )
        })}
        {list.length === 0 && !creating && (
          <li className="px-4 py-3 text-xs text-ink-400">
            {t('boards.emptyHint')}
          </li>
        )}
      </ul>
    </aside>
  )
}

function EmptyBoardsState({ empty }: { empty: boolean }) {
  const t = useT()
  return (
    <div className="h-full grid place-items-center text-ink-400">
      <div className="text-center">
        <IBoard className="w-12 h-12 mx-auto mb-3 opacity-50" />
        <p className="text-sm">
          {empty ? t('boards.emptyCta') : t('boards.pickOne')}
        </p>
      </div>
    </div>
  )
}

/* ============== Canvas (columns + cards) ============== */

function BoardCanvas({ boardId }: { boardId: string }) {
  const t = useT()
  const byId = useParticipants((s) => s.byId)
  const snap = useBoards((s) => s.snapshots[boardId])
  const loadingBoardId = useBoards((s) => s.loadingBoardId)
  const addColumn = useBoards((s) => s.addColumn)
  const deleteBoard = useBoards((s) => s.deleteBoard)
  const renameBoard = useBoards((s) => s.renameBoard)
  const [addingCol, setAddingCol] = useState(false)
  const [colDraft, setColDraft] = useState('')
  const [openCardId, setOpenCardId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')

  // Hooks must run on every render in the same order — keep useMemo
  // above any conditional early return. When the snapshot hasn't
  // hydrated yet we just memoize over an empty board.
  const cardsByColumn = useMemo(() => {
    const m = new Map<string, BoardCard[]>()
    if (!snap) return m
    for (const col of snap.columns) m.set(col.id, [])
    for (const c of snap.cards) {
      const arr = m.get(c.columnId)
      if (arr) arr.push(c)
    }
    for (const [k, arr] of m) {
      arr.sort((a, b) => a.position - b.position)
      m.set(k, arr)
    }
    return m
  }, [snap])

  if (!snap) {
    return (
      <div className="h-full grid place-items-center text-ink-400 text-sm">
        {loadingBoardId === boardId ? t('common.loading') : t('common.noData')}
      </div>
    )
  }

  const openCard = openCardId ? snap.cards.find((c) => c.id === openCardId) ?? null : null

  async function submitNewColumn() {
    const t = colDraft.trim()
    setAddingCol(false)
    setColDraft('')
    if (!t) return
    try { await addColumn(boardId, t) } catch (e) { console.warn('[boards] add column failed', e) }
  }

  async function submitTitle() {
    const t = titleDraft.trim()
    setEditingTitle(false)
    if (!t || t === snap.title) return
    try { await renameBoard(boardId, t) } catch (e) { console.warn('[boards] rename failed', e) }
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <header className="flex items-center justify-between px-6 py-4 border-b border-ink-100">
        <div className="min-w-0 flex-1">
          {editingTitle ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitTitle()
                if (e.key === 'Escape') setEditingTitle(false)
              }}
              onBlur={() => void submitTitle()}
              className="text-2xl font-semibold text-ink-900 bg-transparent border-b border-skype outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => { setTitleDraft(snap.title); setEditingTitle(true) }}
              className="text-2xl font-semibold text-ink-900 hover:text-skype-deep text-left truncate"
            >
              {snap.title}
            </button>
          )}
          {snap.description && (
            <p className="text-sm text-ink-500 mt-1 truncate">
              <MentionedText text={snap.description} byId={byId} />
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={async () => {
            if (!confirm(t('boards.deleteBoardConfirm', { title: snap.title }))) return
            try { await deleteBoard(boardId) } catch (e) { console.warn('[boards] delete failed', e) }
          }}
          className="w-8 h-8 rounded-md grid place-items-center text-ink-400 hover:bg-coral-50 hover:text-coral-deep"
          title={t('boards.deleteBoard')}
          aria-label={t('boards.deleteBoard')}
        >
          <ITrash className="w-4 h-4" />
        </button>
      </header>

      <div className="flex-1 overflow-x-auto overflow-y-hidden min-h-0">
        <div className="h-full flex items-start gap-4 px-6 py-4">
          {snap.columns.map((col) => (
            <ColumnView
              key={col.id}
              boardId={boardId}
              column={col}
              cards={cardsByColumn.get(col.id) ?? []}
              onOpenCard={setOpenCardId}
            />
          ))}
          {addingCol ? (
            <div className="w-72 flex-shrink-0 p-3 rounded-lg bg-[var(--board-column)]">
              <input
                autoFocus
                value={colDraft}
                onChange={(e) => setColDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitNewColumn()
                  if (e.key === 'Escape') { setAddingCol(false); setColDraft('') }
                }}
                onBlur={() => void submitNewColumn()}
                placeholder={t('boards.columnTitlePlaceholder')}
                className="w-full px-2.5 py-1.5 text-sm rounded-md border border-ink-200 bg-cloud focus:outline-none focus:border-skype"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAddingCol(true)}
              className="w-72 flex-shrink-0 px-3 py-2.5 rounded-lg text-sm text-ink-500 border border-dashed border-ink-200 hover:bg-cloud/40 hover:text-ink-700 transition-colors text-left"
            >
              {t('boards.addColumn')}
            </button>
          )}
        </div>
      </div>

      {openCard && (
        <CardDetailModal
          boardId={boardId}
          card={openCard}
          columns={snap.columns}
          onClose={() => setOpenCardId(null)}
        />
      )}
    </div>
  )
}

/* ============== Column ============== */

function ColumnView({ boardId, column, cards, onOpenCard }: {
  boardId: string; column: BoardColumn; cards: BoardCard[]
  onOpenCard: (id: string) => void
}) {
  const t = useT()
  const addCard = useBoards((s) => s.addCard)
  const moveCardOptimistic = useBoards((s) => s.moveCardOptimistic)
  const renameColumn = useBoards((s) => s.renameColumn)
  const deleteColumn = useBoards((s) => s.deleteColumn)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [dragOver, setDragOver] = useState(false)

  async function submit() {
    const title = draft.trim()
    setAdding(false)
    setDraft('')
    if (!title) return
    try {
      await addCard(boardId, { columnId: column.id, title })
    } catch (e) { console.warn('[boards] add card failed', e) }
  }

  async function submitTitle() {
    const t = titleDraft.trim()
    setEditingTitle(false)
    if (!t || t === column.title) return
    try { await renameColumn(boardId, column.id, t) } catch (e) { console.warn('[boards] rename col failed', e) }
  }

  return (
    <div
      className={cn(
        'w-72 flex-shrink-0 h-full flex flex-col rounded-lg bg-[var(--board-column)] transition-colors',
        dragOver && 'ring-2 ring-skype/40 bg-skype/5',
      )}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        const cardId = e.dataTransfer.getData('text/cumora-card')
        if (!cardId) return
        // Drop at the end of this column. Per-card drop targets would be
        // nicer for fine-grained ordering, but end-of-column covers the
        // common "move to Done" gesture.
        void moveCardOptimistic(boardId, cardId, column.id, cards.length)
      }}
    >
      <div className="px-3 pt-3 pb-2 flex items-center justify-between gap-2">
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitTitle()
              if (e.key === 'Escape') setEditingTitle(false)
            }}
            onBlur={() => void submitTitle()}
            className="flex-1 px-1.5 py-0.5 text-sm font-medium rounded-md border border-skype/50 bg-cloud focus:outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => { setTitleDraft(column.title); setEditingTitle(true) }}
            className="text-sm font-medium text-ink-700 hover:text-skype-deep flex-1 text-left truncate"
          >
            {column.title}
          </button>
        )}
        <span className="text-xs text-ink-400">{cards.length}</span>
        <button
          type="button"
          onClick={async () => {
            if (cards.length > 0 && !confirm(t('boards.deleteColumnConfirm', { title: column.title, count: cards.length }))) return
            try { await deleteColumn(boardId, column.id) } catch (e) { console.warn('[boards] delete col failed', e) }
          }}
          className="w-5 h-5 rounded grid place-items-center text-ink-300 hover:text-coral-deep"
          title={t('boards.deleteColumn')}
          aria-label={t('boards.deleteColumn')}
        >
          <IMore className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-2">
        {cards.map((c) => (
          <CardTile key={c.id} card={c} onOpen={() => onOpenCard(c.id)} />
        ))}
        {adding ? (
          <MentionInput
            autoFocus
            value={draft}
            onChange={setDraft}
            onSubmit={() => void submit()}
            onEscape={() => { setAdding(false); setDraft('') }}
            onBlur={() => void submit()}
            placeholder={t('boards.cardTitlePlaceholder')}
            multiline
            submitOnEnter
            rows={2}
            className="w-full px-2.5 py-2 text-sm rounded-md border border-ink-200 bg-cloud focus:outline-none focus:border-skype resize-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="w-full text-left text-xs text-ink-400 px-2.5 py-1.5 rounded-md hover:bg-cloud hover:text-ink-600 transition-colors"
          >
            {t('boards.addCard')}
          </button>
        )}
      </div>
    </div>
  )
}

/* ============== Card tile ============== */

function CardTile({ card, onOpen }: { card: BoardCard; onOpen: () => void }) {
  const byId = useParticipants((s) => s.byId)
  const assignee = card.assigneeId ? byId[card.assigneeId] : null
  return (
    <article
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/cumora-card', card.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      className="cursor-pointer rounded-md border border-[var(--board-card-border)] bg-[var(--board-card)] px-3 py-2.5 text-left shadow-[var(--board-card-shadow)] transition-colors hover:border-skype/40"
    >
      <div className="text-sm text-ink-800 leading-snug">
        <MentionedText text={card.title} byId={byId} />
      </div>
      {(card.assigneeId || card.mentions.length > 0 || card.commentCount > 0) && (
        <div className="mt-2 flex items-center gap-2">
          {assignee && (
            <span className="flex items-center gap-1 text-[11px] text-ink-500">
              <AvatarMini p={assignee} size={18} />
              <span>{assignee.name}</span>
            </span>
          )}
          {card.mentions.length > 0 && !card.assigneeId && (
            <span className="flex items-center gap-0.5 text-[11px] text-ink-400">
              <IAt className="w-3 h-3" />
              {card.mentions.slice(0, 3).map((m) => '@' + (byId[m]?.name ?? m)).join(' ')}
            </span>
          )}
          {card.commentCount > 0 && (
            <span className="ml-auto text-[11px] text-ink-400">{card.commentCount} 💬</span>
          )}
        </div>
      )}
    </article>
  )
}

/* ============== Mention helpers ============== */

const ID_MENTION_RE = /^@([a-z0-9][a-z0-9_-]{0,63})/i
const DOC_REF_RE = /^doc_[a-z0-9]+/i
const BOARD_REF_RE = /^board-[a-z0-9]+(?:-[a-z0-9]+)*/i
const CARD_REF_RE = /^card-[a-z0-9]+(?:-[a-z0-9]+)*/i
const CALENDAR_REF_RE = /^ce-[a-z0-9-]+/i

function hasMentionStartBoundary(text: string, index: number): boolean {
  if (index <= 0) return true
  return !/[\w@]/.test(text[index - 1])
}

function hasMentionEndBoundary(text: string, index: number): boolean {
  const next = text[index]
  return !next || !/[a-z0-9_-]/i.test(next)
}

function hasDocumentBoundary(text: string, index: number): boolean {
  const ch = text[index]
  return !ch || !/[a-z0-9_]/i.test(ch)
}

function hasBoardBoundary(text: string, index: number): boolean {
  const ch = text[index]
  return !ch || !/[a-z0-9_-]/i.test(ch)
}

function hasCardBoundary(text: string, index: number): boolean {
  const ch = text[index]
  return !ch || !/[a-z0-9_-]/i.test(ch)
}

function hasCalendarBoundary(text: string, index: number): boolean {
  const ch = text[index]
  return !ch || !/[a-z0-9-]/i.test(ch)
}

function hasLinkedReference(text: string): boolean {
  return /(^|[^a-z0-9_])doc_[a-z0-9]+($|[^a-z0-9_])/i.test(text) ||
    /(^|[^a-z0-9_-])board-[a-z0-9]+(?:-[a-z0-9]+)*($|[^a-z0-9_-])/i.test(text) ||
    /(^|[^a-z0-9_-])card-[a-z0-9]+(?:-[a-z0-9]+)*($|[^a-z0-9_-])/i.test(text) ||
    /(^|[^a-z0-9-])ce-[a-z0-9-]+($|[^a-z0-9-])/i.test(text)
}

function knownMentionCandidates(byId: Record<string, Participant>): Array<{ id: string; label: string; token: string }> {
  const candidates: Array<{ id: string; label: string; token: string }> = []
  for (const p of Object.values(byId)) {
    if (p.departedAt) continue
    candidates.push({ id: p.id, label: p.name, token: p.id })
    const name = p.name.trim()
    if (name) candidates.push({ id: p.id, label: p.name, token: name })
  }
  return candidates.sort((a, b) => b.token.length - a.token.length)
}

/** Render prose, replacing `@<id>` tokens with chips. Bonus: an
 *  unrecognized id still renders as a chip (dimmer) so the writer's
 *  intent is preserved even before the named participant exists. */
function MentionedText({ text, byId }: { text: string; byId: Record<string, Participant> }) {
  const parts: Array<
    | { kind: 'text'; value: string }
    | { kind: 'document'; id: string }
    | { kind: 'board'; id: string }
    | { kind: 'card'; id: string }
    | { kind: 'calendar'; id: string }
    | { kind: 'mention'; id: string; label: string; known: boolean }
  > = []
  const candidates = knownMentionCandidates(byId)
  const lower = text.toLowerCase()
  let last = 0
  for (let i = 0; i < text.length; i++) {
    if (hasDocumentBoundary(text, i - 1)) {
      const doc = DOC_REF_RE.exec(text.slice(i))
      if (doc && hasDocumentBoundary(text, i + doc[0].length)) {
        if (i > last) parts.push({ kind: 'text', value: text.slice(last, i) })
        parts.push({ kind: 'document', id: doc[0] })
        last = i + doc[0].length
        i = last - 1
        continue
      }
    }

    if (hasBoardBoundary(text, i - 1)) {
      const board = BOARD_REF_RE.exec(text.slice(i))
      if (board && hasBoardBoundary(text, i + board[0].length)) {
        if (i > last) parts.push({ kind: 'text', value: text.slice(last, i) })
        parts.push({ kind: 'board', id: board[0] })
        last = i + board[0].length
        i = last - 1
        continue
      }
    }

    if (hasCardBoundary(text, i - 1)) {
      const card = CARD_REF_RE.exec(text.slice(i))
      if (card && hasCardBoundary(text, i + card[0].length)) {
        if (i > last) parts.push({ kind: 'text', value: text.slice(last, i) })
        parts.push({ kind: 'card', id: card[0] })
        last = i + card[0].length
        i = last - 1
        continue
      }
    }

    if (hasCalendarBoundary(text, i - 1)) {
      const event = CALENDAR_REF_RE.exec(text.slice(i))
      if (event && hasCalendarBoundary(text, i + event[0].length)) {
        if (i > last) parts.push({ kind: 'text', value: text.slice(last, i) })
        parts.push({ kind: 'calendar', id: event[0] })
        last = i + event[0].length
        i = last - 1
        continue
      }
    }

    if (text[i] !== '@' || !hasMentionStartBoundary(text, i)) continue
    const rest = lower.slice(i + 1)
    const known = candidates.find((candidate) =>
      rest.startsWith(candidate.token.toLowerCase()) &&
      hasMentionEndBoundary(text, i + 1 + candidate.token.length)
    )
    const fallback = known ? null : ID_MENTION_RE.exec(text.slice(i))
    if (!known && !fallback) continue
    if (i > last) parts.push({ kind: 'text', value: text.slice(last, i) })
    if (known) {
      parts.push({ kind: 'mention', id: known.id, label: known.label, known: true })
      last = i + 1 + known.token.length
    } else if (fallback) {
      const id = fallback[1].toLowerCase()
      parts.push({ kind: 'mention', id, label: id, known: false })
      last = i + fallback[0].length
    }
    i = last - 1
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) })
  return (
    <>
      {parts.map((p, i) => {
        if (p.kind === 'text') return <span key={i}>{p.value}</span>
        if (p.kind === 'document') return <DocumentLink key={i} id={p.id} />
        if (p.kind === 'board') return <BoardLink key={i} id={p.id} />
        if (p.kind === 'card') return <CardLink key={i} id={p.id} />
        if (p.kind === 'calendar') return <CalendarLink key={i} id={p.id} />
        return (
          <span
            key={i}
            className={cn(
              'inline-flex items-baseline px-1.5 rounded text-[12px] font-medium',
              p.known ? 'bg-skype/10 text-skype-deep' : 'bg-ink-100 text-ink-500',
            )}
            title={p.id}
          >@{p.label}</span>
        )
      })}
    </>
  )
}

/** Single-line text input with an `@`-triggered participant picker. The
 *  picker substring-matches against id+name; ↑/↓ navigate, Enter inserts. */
function MentionInput(props: {
  value: string
  onChange: (v: string) => void
  onSubmit?: () => void
  placeholder?: string
  multiline?: boolean
  rows?: number
  className?: string
  autoFocus?: boolean
  submitOnEnter?: boolean
  onBlur?: () => void
  onEscape?: () => void
}) {
  const byId = useParticipants((s) => s.byId)
  const everyone = useMemo(() => Object.values(byId), [byId])
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [anchor, setAnchor] = useState(0) // index of the leading '@'

  const matches = useMemo(() => {
    const q = query.toLowerCase()
    return everyone
      .filter((p) => !p.departedAt)
      .filter((p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
      .slice(0, 6)
  }, [everyone, query])

  function update(next: string, caretPos: number) {
    props.onChange(next)
    // Look back from the caret to find a still-open `@token` — break on
    // whitespace, the start-of-string, or any character not allowed in
    // an id. We must also reject the case where the char immediately
    // before `@` is an ident-ish char (matches the regex's lookbehind).
    let i = caretPos - 1
    while (i >= 0) {
      const ch = next[i]
      if (ch === '@') {
        const prev = i > 0 ? next[i - 1] : ''
        if (!prev || /[\s([]/.test(prev)) {
          const token = next.slice(i + 1, caretPos)
          if (/^[a-z0-9_-]*$/i.test(token)) {
            setOpen(true)
            setAnchor(i)
            setQuery(token)
            setHighlight(0)
            return
          }
        }
        break
      }
      if (!/[a-z0-9_-]/i.test(ch)) break
      i--
    }
    setOpen(false)
  }

  function insertMention(p: Participant) {
    const el = ref.current
    if (!el) { setOpen(false); return }
    const before = props.value.slice(0, anchor)
    const caret = el.selectionStart ?? props.value.length
    const after = props.value.slice(caret)
    const inserted = `@${p.name.trim() || p.id} `
    const next = before + inserted + after
    props.onChange(next)
    setOpen(false)
    queueMicrotask(() => {
      const pos = (before + inserted).length
      el.setSelectionRange(pos, pos)
      el.focus()
    })
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.nativeEvent.isComposing) return
    if (open && matches.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => (h + 1) % matches.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => (h - 1 + matches.length) % matches.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(matches[highlight]); return }
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return }
    }
    if (!open && e.key === 'Enter' && !e.shiftKey && props.onSubmit && !props.multiline) {
      e.preventDefault()
      props.onSubmit()
      return
    }
    if (!open && props.multiline && e.key === 'Enter' && (e.metaKey || e.ctrlKey) && props.onSubmit) {
      e.preventDefault()
      props.onSubmit()
      return
    }
    if (!open && props.multiline && props.submitOnEnter && e.key === 'Enter' && !e.shiftKey && props.onSubmit) {
      e.preventDefault()
      props.onSubmit()
      return
    }
    if (!open && e.key === 'Escape' && props.onEscape) {
      e.preventDefault()
      props.onEscape()
    }
  }

  return (
    <div className="relative">
      {props.multiline ? (
        <textarea
          ref={ref as React.RefObject<HTMLTextAreaElement>}
          autoFocus={props.autoFocus}
          value={props.value}
          rows={props.rows ?? 3}
          placeholder={props.placeholder}
          onChange={(e) => update(e.target.value, e.target.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
          onBlur={props.onBlur}
          className={cn(
            'w-full px-3 py-2 text-sm rounded-md border border-ink-200 bg-cloud focus:outline-none focus:border-skype resize-y',
            props.className,
          )}
        />
      ) : (
        <input
          ref={ref as React.RefObject<HTMLInputElement>}
          autoFocus={props.autoFocus}
          value={props.value}
          placeholder={props.placeholder}
          onChange={(e) => update(e.target.value, e.target.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
          onBlur={props.onBlur}
          className={cn(
            'w-full px-3 py-2 text-sm rounded-md border border-ink-200 bg-cloud focus:outline-none focus:border-skype',
            props.className,
          )}
        />
      )}
      {open && matches.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 max-h-56 overflow-y-auto rounded-md border border-ink-200 bg-cloud shadow-lg z-20">
          {matches.map((p, i) => (
            <button
              key={p.id}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); insertMention(p) }}
              onMouseEnter={() => setHighlight(i)}
              className={cn(
                'w-full px-2 py-1.5 flex items-center gap-2 text-left text-sm',
                i === highlight ? 'bg-skype/10' : 'hover:bg-ink-50',
              )}
            >
              <AvatarMini p={p} size={20} />
              <span className="font-medium text-ink-800">{p.name}</span>
              <span className="text-xs text-ink-400">@{p.id}</span>
              <span className="ml-auto text-[10px] uppercase tracking-wide text-ink-300">{p.kind}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ============== Card detail modal ============== */

/** Module-level constant so the "no comments yet" fallback is referentially
 *  stable across renders — see the comment in CardDetailModal where it's used. */
const EMPTY_COMMENTS: BoardCardComment[] = []

function CardDetailModal({ boardId, card, columns, onClose }: {
  boardId: string; card: BoardCard; columns: BoardColumn[]; onClose: () => void
}) {
  const t = useT()
  const byId = useParticipants((s) => s.byId)
  const meId = useMe()
  const patchCard = useBoards((s) => s.patchCard)
  const deleteCard = useBoards((s) => s.deleteCard)
  const loadComments = useBoards((s) => s.loadComments)
  const addComment = useBoards((s) => s.addComment)
  // Select the raw entry (may be undefined), then fall back OUTSIDE the
  // selector — `?? []` inside would mint a new array literal on every
  // call, fail Object.is, and cycle render → reselect → render forever.
  const commentsRaw = useBoards((s) => s.comments[card.id])
  const comments: BoardCardComment[] = commentsRaw ?? EMPTY_COMMENTS
  const [title, setTitle] = useState(card.title)
  const [description, setDescription] = useState(card.description ?? '')
  const [draftComment, setDraftComment] = useState('')
  const [posting, setPosting] = useState(false)

  useEffect(() => {
    setTitle(card.title)
    setDescription(card.description ?? '')
  }, [card.id, card.title, card.description])

  useEffect(() => {
    void loadComments(boardId, card.id)
  }, [loadComments, boardId, card.id])

  async function saveTitle() {
    const next = title.trim()
    if (!next || next === card.title) return
    try { await patchCard(boardId, card.id, { title: next }) } catch (e) { console.warn(e) }
  }
  async function saveDescription() {
    const next = description.trim()
    if (next === (card.description ?? '')) return
    try { await patchCard(boardId, card.id, { description: next }) } catch (e) { console.warn(e) }
  }
  async function moveToColumn(columnId: string) {
    if (columnId === card.columnId) return
    try { await patchCard(boardId, card.id, { columnId }) } catch (e) { console.warn(e) }
  }
  async function setAssignee(id: string | null) {
    try { await patchCard(boardId, card.id, { assigneeId: id }) } catch (e) { console.warn(e) }
  }
  async function postComment() {
    const body = draftComment.trim()
    if (!body || posting) return
    setPosting(true)
    try {
      await addComment(boardId, card.id, body)
      setDraftComment('')
    } catch (e) {
      console.warn(e)
    } finally {
      setPosting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[var(--modal-scrim)] p-6" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-cloud w-full max-w-2xl max-h-[85vh] rounded-xl shadow-xl flex flex-col"
      >
        <header className="px-5 py-4 border-b border-ink-100 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <MentionInput
              value={title}
              onChange={setTitle}
              onSubmit={() => void saveTitle()}
              placeholder={t('boards.cardTitleEditPlaceholder')}
              className="-ml-2 w-full border-transparent bg-transparent px-2 py-1.5 text-[19px] font-semibold leading-7 text-ink-900 placeholder:text-ink-300 focus:border-skype/30 focus:bg-cloud focus:ring-2 focus:ring-skype/15"
            />
          </div>
          <button
            type="button"
            onClick={() => { void saveTitle().then(onClose) }}
            className="shrink-0 rounded-md px-2.5 py-1.5 text-sm text-ink-500 hover:bg-sky2-50 hover:text-skype-deep"
          >{t('common.close')}</button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <section className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-ink-400 mb-1">{t('boards.column')}</div>
              <Select
                value={card.columnId}
                onValueChange={(columnId) => void moveToColumn(columnId)}
                options={columns.map((c) => ({ value: c.id, label: c.title }))}
                ariaLabel={t('boards.ariaColumn')}
              />
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-ink-400 mb-1">{t('boards.assignee')}</div>
              <AssigneePicker
                value={card.assigneeId}
                onChange={(id) => void setAssignee(id)}
                meId={meId ?? null}
              />
            </div>
          </section>

          <section>
            <div className="text-[11px] uppercase tracking-wide text-ink-400 mb-1">{t('boards.description')}</div>
            <MentionInput
              value={description}
              onChange={setDescription}
              onSubmit={() => void saveDescription()}
              placeholder={t('boards.descPlaceholder')}
              multiline
              rows={4}
            />
            {hasLinkedReference(description) && (
              <div className="mt-2 text-sm text-ink-700 whitespace-pre-wrap">
                <MentionedText text={description} byId={byId} />
              </div>
            )}
            <div className="mt-1 flex justify-end">
              <button
                type="button"
                onClick={() => void saveDescription()}
                className="text-xs text-ink-500 hover:text-skype-deep px-2 py-1"
              >{t('boards.saveDescription')}</button>
            </div>
          </section>

          <section>
            <div className="text-[11px] uppercase tracking-wide text-ink-400 mb-1">
              {t('boards.comments')}{comments.length > 0 && <span className="text-ink-500">· {comments.length}</span>}
            </div>
            <ul className="space-y-2">
              {comments.map((c) => {
                const author = byId[c.authorId]
                return (
                  <li key={c.id} className="flex items-start gap-2.5">
                    {author ? <AvatarMini p={author} size={26} /> : <span className="w-6 h-6 rounded-full bg-ink-200" />}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-medium text-ink-800">{author?.name ?? c.authorId}</span>
                        <span className="text-[11px] text-ink-400">{formatTime(c.createdAt)}</span>
                      </div>
                      <div className="text-sm text-ink-700 whitespace-pre-wrap">
                        <MentionedText text={c.body} byId={byId} />
                      </div>
                    </div>
                  </li>
                )
              })}
              {comments.length === 0 && (
                <li className="text-xs text-ink-400">{t('boards.noCommentsYet')}</li>
              )}
            </ul>
            <div className="mt-3">
              <MentionInput
                value={draftComment}
                onChange={setDraftComment}
                onSubmit={() => void postComment()}
                placeholder={t('boards.commentPlaceholder')}
                multiline
                rows={2}
              />
              <div className="mt-1 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => void postComment()}
                  disabled={!draftComment.trim() || posting}
                  className="px-3 py-1.5 text-sm rounded-md bg-skype text-white hover:bg-skype-deep disabled:opacity-40 disabled:hover:bg-skype"
                >{t('boards.postComment')}</button>
              </div>
            </div>
          </section>
        </div>

        <footer className="px-5 py-3 border-t border-ink-100 flex items-center justify-between">
          <div className="text-[11px] text-ink-400">
            {t('boards.createdByAt', { time: formatTime(card.createdAt), author: byId[card.createdBy]?.name ?? card.createdBy })}
          </div>
          <button
            type="button"
            onClick={async () => {
              if (!confirm(t('boards.deleteCardConfirm'))) return
              try { await deleteCard(boardId, card.id); onClose() } catch (e) { console.warn(e) }
            }}
            className="text-xs text-coral-deep hover:underline"
          >{t('boards.deleteCard')}</button>
        </footer>
      </div>
    </div>
  )
}

function AssigneePicker({ value, onChange, meId }: {
  value: string | null; onChange: (id: string | null) => void; meId: string | null
}) {
  const t = useT()
  const byId = useParticipants((s) => s.byId)
  const id = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const everyone = useMemo(() =>
    Object.values(byId).filter((p) => !p.departedAt)
      .sort((a, b) => {
        // Me first, then humans, then agents, then alphabetical.
        if (a.id === meId) return -1
        if (b.id === meId) return 1
        if (a.kind !== b.kind) return a.kind === 'human' ? -1 : 1
        return a.name.localeCompare(b.name)
      }),
    [byId, meId],
  )
  const selected = value ? everyone.find((p) => p.id === value) ?? null : null
  const options = useMemo(() => [
    { id: null, label: t('boards.unassigned'), meta: '', participant: null as Participant | null },
    ...everyone.map((p) => ({
      id: p.id,
      label: p.name,
      meta: p.kind === 'agent' ? t('common.agent') : (p.id === meId ? t('common.you') : t('common.human')),
      participant: p,
    })),
  ], [everyone, meId, t])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return options
    return options.filter((option) =>
      option.label.toLowerCase().includes(needle) ||
      option.meta.toLowerCase().includes(needle) ||
      (option.id ?? '').toLowerCase().includes(needle)
    )
  }, [options, query])

  useEffect(() => {
    if (!open) return
    const idx = filtered.findIndex((option) => option.id === value)
    setActiveIndex(Math.max(0, idx))
  }, [filtered, open, value])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (target && rootRef.current?.contains(target)) return
      setOpen(false)
      setQuery('')
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [open])

  function openMenu() {
    setOpen(true)
    setQuery('')
    queueMicrotask(() => inputRef.current?.focus())
  }

  function commit(option: (typeof options)[number] | undefined) {
    if (!option) return
    onChange(option.id)
    setOpen(false)
    setQuery('')
    inputRef.current?.blur()
  }

  const displayValue = open ? query : (selected ? `${selected.name}${selected.kind === 'agent' ? ` · ${t('common.agent')}` : ''}` : t('boards.unassigned'))

  return (
    <div ref={rootRef} className="relative">
      <div
        className={cn(
          'group relative flex h-11 w-full items-center rounded-[14px] border border-ink-100 bg-cloud text-left text-[13px] font-semibold text-ink-900 outline-none transition',
          'shadow-[var(--select-shadow)]',
          'hover:border-sky2-200 hover:bg-sky2-50/60',
          open && 'border-sky2-300 bg-cloud ring-4 ring-sky2-100',
        )}
        style={{
          backgroundImage: 'var(--select-face)',
        }}
      >
        {!open && (
          <span className="pointer-events-none absolute left-3 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center">
            {selected
              ? <AvatarMini p={selected} size={26} />
              : <span className="grid h-[26px] w-[26px] place-items-center rounded-full bg-ink-100 text-[12px] text-ink-400">-</span>}
          </span>
        )}
        <input
          ref={inputRef}
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-listbox`}
          aria-activedescendant={open && filtered[activeIndex] ? `${id}-option-${activeIndex}` : undefined}
          value={displayValue}
          placeholder={t('boards.searchAssignees')}
          onFocus={openMenu}
          onMouseDown={() => {
            if (!open) openMenu()
          }}
          onChange={(event) => {
            if (!open) setOpen(true)
            setQuery(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              if (!open) { openMenu(); return }
              setActiveIndex((idx) => Math.min(filtered.length - 1, idx + 1))
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              if (!open) { openMenu(); return }
              setActiveIndex((idx) => Math.max(0, idx - 1))
              return
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              commit(filtered[activeIndex])
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              setOpen(false)
              setQuery('')
            }
          }}
          className={cn(
            'h-full min-w-0 flex-1 rounded-[14px] bg-transparent px-3.5 pr-[76px] text-[13px] font-semibold text-ink-900 outline-none placeholder:text-ink-300',
            !open && 'pl-11',
          )}
        />
        {value && (
          <button
            type="button"
            aria-label={t('boards.clearAssignee')}
            title={t('boards.clearAssignee')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChange(null)}
            className="absolute right-[45px] grid h-7 w-7 place-items-center rounded-[9px] text-ink-300 transition hover:bg-sky2-50 hover:text-ink-600"
          >
            <span aria-hidden="true" className="text-base leading-none">×</span>
          </button>
        )}
        <button
          type="button"
          aria-label={t('boards.openAssigneeMenu')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => openMenu()}
          className={cn(
            'absolute right-2 grid h-7 w-7 place-items-center rounded-[9px] border border-sky2-100 bg-sky2-50 text-skype-deep transition',
            'group-hover:bg-cloud group-focus-within:bg-sky2-50',
            open && 'border-sky2-200 bg-sky2-50',
          )}
        >
          <svg viewBox="0 0 14 14" className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} fill="none">
            <path d="M3.5 5.5 7 9l3.5-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {open && (
        <div
          id={`${id}-listbox`}
          role="listbox"
          className="absolute left-0 right-0 top-full z-[70] mt-2 max-h-72 overflow-auto rounded-[16px] border border-[var(--select-menu-border)] bg-cloud p-2.5 shadow-[var(--select-menu-shadow)] animate-rise"
        >
          {filtered.map((option, idx) => {
            const active = idx === activeIndex
            const selectedOption = option.id === value
            return (
              <button
                key={option.id ?? 'unassigned'}
                id={`${id}-option-${idx}`}
                type="button"
                role="option"
                aria-selected={selectedOption}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => commit(option)}
                className={cn(
                  'flex h-9 w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-[12.5px] font-semibold transition',
                  selectedOption
                    ? 'bg-skype text-white shadow-[0_10px_22px_-16px_rgba(0,120,200,0.82)]'
                    : active
                      ? 'bg-sky2-50 text-skype-deep'
                      : 'text-ink-700 hover:bg-sky2-50 hover:text-skype-deep',
                )}
              >
                {option.participant
                  ? <AvatarMini p={option.participant} size={22} />
                  : <span className="grid h-[22px] w-[22px] place-items-center rounded-full bg-ink-100 text-[11px] text-ink-400">-</span>}
                <span className="min-w-0 flex-1 truncate font-medium">{option.label}</span>
                {option.meta && (
                  <span className={cn(
                    'shrink-0 text-[10px] uppercase tracking-wide',
                    selectedOption ? 'text-white/70' : 'text-ink-300',
                  )}>{option.meta}</span>
                )}
              </button>
            )
          })}
          {filtered.length === 0 && (
            <div className="px-3 py-3 text-[12.5px] font-semibold text-ink-400">{t('boards.noMatchingTeammate')}</div>
          )}
        </div>
      )}
    </div>
  )
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch { return iso }
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
// In TipTap v3, CollaborationCursor was renamed to CollaborationCaret and
// repointed at the new @tiptap/y-tiptap binding. The legacy
// extension-collaboration-cursor@3 is a shim still wired to y-prosemirror
// and crashes against v3's sync plugin (ySyncPluginKey mismatch).
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import Placeholder from '@tiptap/extension-placeholder'
import Link from '@tiptap/extension-link'
import ImageExtension from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import * as Y from 'yjs'
import { openDocument, type YDocSession } from '@/lib/yjsClient'
import { buildMentionExtension } from '@/lib/mentionExtension'
import { useDocuments } from '@/stores/documents'
import { useAuth } from '@/stores/auth'
import { api, ws } from '@/api/client'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import {
  IBold, IItalic, IStrike, IH1, IH2, IH3,
  IList, IListOrdered, IQuote, ICode, ICodeBlock, ILink, IImage, IUndo, IRedo,
} from '@/components/EditorIcons'

/** Walk every `mention` node currently in the editor's doc and return
 *  the set of mentioned participant ids (deduped, order-preserving).
 *  Cheaper than diffing the whole ProseMirror tree on every update —
 *  the editor doc traversal is O(N) over the leaves and fires only on
 *  doc changes, so it's well below render-budget. */
function collectMentionIds(editor: Editor): string[] {
  const out = new Set<string>()
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'mention') {
      const id = (node.attrs as { id?: string }).id
      if (id) out.add(id)
    }
    return true
  })
  return Array.from(out)
}

/** Stable color per user. Hash → palette so two clients with the same
 *  user id agree on the same swatch without coordination. */
function colorForId(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  const palette = [
    '#f97316', '#ef4444', '#ec4899', '#a855f7',
    '#6366f1', '#3b82f6', '#0ea5e9', '#14b8a6',
    '#10b981', '#84cc16', '#eab308', '#f59e0b',
  ]
  return palette[h % palette.length]
}

function isSafeImageUrl(url: string): boolean {
  return /^(https?:\/\/|\/(?!\/))/i.test(url)
}

const DocumentImageExtension = ImageExtension.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      storageKey: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-storage-key'),
        renderHTML: (attrs: { storageKey?: string | null }) =>
          attrs.storageKey ? { 'data-storage-key': attrs.storageKey } : {},
      },
    }
  },
})

function imageSrcFromEventTarget(target: EventTarget | null): HTMLImageElement | null {
  return target instanceof HTMLImageElement ? target : null
}

function getEditorView(editor: Editor): Editor['view'] | null {
  try {
    return editor.view
  } catch {
    return null
  }
}

function getEditorDom(editor: Editor): HTMLElement | null {
  return getEditorView(editor)?.dom ?? null
}

function updateImageNodeAttrs(
  editor: Editor,
  oldSrc: string,
  storageKey: string | null,
  nextAttrs: { src: string; storageKey?: string | null },
): boolean {
  const view = getEditorView(editor)
  if (!view) return false
  let updated = false
  editor.state.doc.descendants((node, pos) => {
    const attrs = node.attrs as { src?: string; storageKey?: string | null }
    const matches = attrs.src === oldSrc || (storageKey && attrs.storageKey === storageKey)
    if (updated || node.type.name !== 'image' || !matches) return !updated
    view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...nextAttrs }))
    updated = true
    return false
  })
  return updated
}

interface DocumentEditorProps {
  documentId: string
  variant?: 'full' | 'peek'
  onClose?: () => void
  onOpenFull?: () => void
}

export function DocumentEditor({ documentId, variant = 'full', onClose, onOpenFull }: DocumentEditorProps) {
  const t = useT()
  const user = useAuth((s) => s.user)
  const doc = useDocuments((s) => s.list.find((d) => d.id === documentId) ?? null)
  const rename = useDocuments((s) => s.rename)
  const remove = useDocuments((s) => s.remove)

  // The Yjs session owns the Y.Doc + Awareness; TipTap binds to them via
  // the Collaboration / CollaborationCursor extensions.
  const sessionRef = useRef<YDocSession | null>(null)
  const [session, setSession] = useState<YDocSession | null>(null)
  const [synced, setSynced] = useState(false)
  const [titleDraft, setTitleDraft] = useState(doc?.title ?? '')

  useEffect(() => { setTitleDraft(doc?.title ?? '') }, [doc?.id, doc?.title])

  useEffect(() => {
    if (!user) return
    const s = openDocument({
      documentId,
      user: { id: user.id, name: user.name, color: colorForId(user.id) },
    })
    sessionRef.current = s
    setSession(s)
    setSynced(false)
    void s.synced.then(() => setSynced(true))
    return () => {
      s.destroy()
      sessionRef.current = null
      setSession(null)
      setSynced(false)
    }
  }, [documentId, user])

  if (!doc) return (
    <div className="h-full flex items-center justify-center text-stone-400 text-sm">
      {t('docEdit.notFound')}
    </div>
  )
  if (!user || !session) return (
    <div className="h-full flex items-center justify-center text-stone-400 text-sm">
      {t('common.loading')}
    </div>
  )

  const commitTitle = async () => {
    const trimmed = titleDraft.trim()
    if (!trimmed || trimmed === doc.title) {
      setTitleDraft(doc.title)
      return
    }
    try { await rename(doc.id, trimmed) } catch { setTitleDraft(doc.title) }
  }

  const isPeek = variant === 'peek'

  return (
    <div className="h-full flex flex-col bg-white">
      <header
        className={cn(
          'border-b border-stone-200 flex items-center gap-2.5 min-w-0',
          isPeek ? 'px-4 py-3 bg-gradient-to-b from-white to-sky2-50/35' : 'px-6 py-3',
        )}
      >
        <input
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          className={cn(
            'flex-1 min-w-0 bg-transparent font-medium text-stone-900 focus:outline-none',
            isPeek ? 'text-[16px] leading-[1.35]' : 'text-xl',
          )}
          placeholder={t('docEdit.untitledPh')}
          aria-label={t('docEdit.titleAria')}
        />
        <div className="shrink-0">
          <PresenceStrip session={session} synced={synced} />
        </div>
        {isPeek && onOpenFull ? (
          <button
            type="button"
            onClick={onOpenFull}
            className="w-8 h-8 rounded-[8px] grid place-items-center text-ink-500 hover:text-skype-deep hover:bg-sky2-100 transition"
            title={t('docEdit.openInDocs')}
            aria-label={t('docEdit.openInDocs')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <path d="M14 4h6v6" />
              <path d="M20 4l-9 9" />
              <path d="M20 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4" />
            </svg>
          </button>
        ) : null}
        {isPeek && onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-[8px] grid place-items-center text-ink-400 hover:text-ink-900 hover:bg-ink-100/70 transition"
            title={t('docEdit.closeDocument')}
            aria-label={t('docEdit.closeDocument')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (!confirm(t('docEdit.deleteConfirm'))) return
              void remove(doc.id).catch(() => { /* swallow */ })
            }}
            className="text-xs leading-none text-stone-500 hover:text-red-600 transition-colors"
          >
            {t('docEdit.deleteAction')}
          </button>
        )}
      </header>
      <CollaborativeEditor
        session={session}
        synced={synced}
        userName={user.name}
        userColor={colorForId(user.id)}
        documentId={documentId}
        variant={variant}
      />
    </div>
  )
}

interface CollaborativeEditorProps {
  session: YDocSession
  synced: boolean
  userName: string
  userColor: string
  documentId: string
  variant: 'full' | 'peek'
}

function CollaborativeEditor({ session, synced, userName, userColor, documentId, variant }: CollaborativeEditorProps) {
  const t = useT()
  const refreshingImagesRef = useRef(new Set<string>())
  // Memoize the awareness object reference for the cursor extension —
  // TipTap reads it once at mount.
  const placeholderText = t('docEdit.placeholder')
  const extensions = useMemo(() => [
    // Disable StarterKit's undo/redo because Collaboration ships its own
    // (Yjs-aware) one — running both yields double-undos. TipTap v3
    // renamed this option from `history` to `undoRedo`.
    StarterKit.configure({ undoRedo: false }),
    // Tables: agents write GFM tables in markdown docs (the server converts
    // them to ProseMirror table nodes in documents/markdown.ts); without
    // this extension those nodes are unknown to the schema and the doc
    // falls back to rendering the raw pipes as text.
    TableKit.configure({ table: { resizable: false } }),
    Link.configure({ openOnClick: false, autolink: true }),
    DocumentImageExtension.configure({
      allowBase64: false,
    }),
    Placeholder.configure({
      placeholder: placeholderText,
    }),
    Collaboration.configure({ document: session.doc }),
    CollaborationCaret.configure({
      provider: { awareness: session.awareness } as never,
      user: { name: userName, color: userColor },
    }),
    // @mention: typing `@` opens the participant picker; selecting one
    // inserts a `mention` node carrying { id, label }. The mention
    // travels through Yjs so all collaborators see the same canonical
    // ids — which is what lets the server-side notifier work without
    // having to second-guess fuzzy text matches.
    buildMentionExtension(),
  ], [session, userName, userColor, placeholderText])

  const editor = useEditor({
    extensions,
    editable: synced,
    editorProps: {
      attributes: {
        class: cn(
          'tiptap prose prose-stone max-w-none focus:outline-none min-h-full font-serif',
          variant === 'peek' ? 'px-6 py-6' : 'px-10 py-8',
        ),
      },
    },
  }, [session, userName, userColor, variant])

  // Flip the editor to editable when sync completes.
  useEffect(() => {
    if (editor) editor.setEditable(synced)
  }, [editor, synced])

  // Detect newly-inserted @mentions and notify the server. We diff
  // against the mention set we observed at the LAST tick so:
  //   - On initial sync we seed the "known" set without re-firing
  //     notifications for mentions that were already in the doc.
  //   - Subsequent edits — local OR remote (agent / other human) —
  //     fire only on the delta. Remote-inserted mentions go through
  //     the server-side scanner anyway (the original inserter's
  //     client already notified), so we'd double-fire without the
  //     diff.
  // Single-fire-per-id semantics: once an id appears in the set it's
  // "seen"; removing+re-adding the same id within a session won't
  // re-notify, which is the correct UX (treat as no-op churn).
  useEffect(() => {
    if (!editor || !synced) return
    const seen = new Set<string>(collectMentionIds(editor))
    const onUpdate = () => {
      const current = collectMentionIds(editor)
      const fresh: string[] = []
      for (const id of current) {
        if (!seen.has(id)) {
          seen.add(id)
          fresh.push(id)
        }
      }
      if (fresh.length > 0) {
        ws.send({ type: 'doc.mention.notify', documentId, mentionedIds: fresh })
      }
    }
    editor.on('update', onUpdate)
    return () => { editor.off('update', onUpdate) }
  }, [editor, synced, documentId])

  useEffect(() => {
    if (!editor) return
    const refreshImage = (img: HTMLImageElement) => {
      const src = img.getAttribute('src') || img.currentSrc
      const storageKey = img.getAttribute('data-storage-key')
      const refreshId = storageKey || src
      if (!refreshId || refreshingImagesRef.current.has(refreshId)) return
      refreshingImagesRef.current.add(refreshId)
      void api.refreshUploadUrl({ url: src, key: storageKey || undefined })
        .then(({ key, url }) => {
          if (!url || url === src) return
          if (!updateImageNodeAttrs(editor, src, storageKey, { src: url, storageKey: key })) {
            img.setAttribute('data-storage-key', key)
            img.src = url
          }
        })
        .catch(() => { /* non-Cumora or not-yet-deployed refresh endpoint */ })
        .finally(() => refreshingImagesRef.current.delete(refreshId))
    }
    const onError = (event: Event) => {
      const img = imageSrcFromEventTarget(event.target)
      if (img) refreshImage(img)
    }
    const sweepBrokenImages = (dom: HTMLElement) => {
      dom.querySelectorAll('img').forEach((img) => {
        if (img.complete && img.naturalWidth === 0) refreshImage(img)
      })
    }
    let dom: HTMLElement | null = null
    let attachTimer: number | undefined
    let sweepTimer: number | undefined
    let mounted = true
    const attach = () => {
      if (!mounted) return
      dom = getEditorDom(editor)
      if (!dom) {
        attachTimer = window.setTimeout(attach, 50)
        return
      }
      dom.addEventListener('error', onError, true)
      sweepTimer = window.setTimeout(() => {
        if (dom) sweepBrokenImages(dom)
      }, 0)
    }
    attach()
    return () => {
      mounted = false
      if (attachTimer !== undefined) window.clearTimeout(attachTimer)
      if (sweepTimer !== undefined) window.clearTimeout(sweepTimer)
      dom?.removeEventListener('error', onError, true)
    }
  }, [editor])

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <Toolbar editor={editor} disabled={!synced} />
      <div className="flex-1 overflow-y-auto">
        <EditorContent editor={editor} className="h-full" />
      </div>
    </div>
  )
}

/* ============== Toolbar ============== */

interface ToolbarProps { editor: Editor | null; disabled: boolean }

function Toolbar({ editor, disabled }: ToolbarProps) {
  const t = useT()
  if (!editor) {
    return <div className="border-b border-stone-100 px-4 py-2 h-[42px] bg-stone-50/60" />
  }
  const btn = (active: boolean) => cn(
    'w-8 h-8 grid place-items-center rounded-md transition-colors',
    disabled ? 'text-stone-300' : (
      active
        ? 'bg-skype/15 text-skype-deep'
        : 'text-stone-600 hover:bg-stone-100'
    ),
  )
  return (
    <div className="border-b border-stone-100 px-3 py-1.5 bg-stone-50/60 flex items-center gap-0.5 flex-wrap">
      <button
        type="button" className={btn(editor.isActive('bold'))} disabled={disabled}
        onClick={() => editor.chain().focus().toggleBold().run()}
        title={t('docEdit.bold')}
      ><IBold className="w-4 h-4" /></button>
      <button
        type="button" className={btn(editor.isActive('italic'))} disabled={disabled}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title={t('docEdit.italic')}
      ><IItalic className="w-4 h-4" /></button>
      <button
        type="button" className={btn(editor.isActive('strike'))} disabled={disabled}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        title={t('docEdit.strikethrough')}
      ><IStrike className="w-4 h-4" /></button>
      <ToolbarSep />
      <button
        type="button" className={btn(editor.isActive('heading', { level: 1 }))} disabled={disabled}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        title={t('docEdit.heading1')}
      ><IH1 className="w-4 h-4" /></button>
      <button
        type="button" className={btn(editor.isActive('heading', { level: 2 }))} disabled={disabled}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        title={t('docEdit.heading2')}
      ><IH2 className="w-4 h-4" /></button>
      <button
        type="button" className={btn(editor.isActive('heading', { level: 3 }))} disabled={disabled}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        title={t('docEdit.heading3')}
      ><IH3 className="w-4 h-4" /></button>
      <ToolbarSep />
      <button
        type="button" className={btn(editor.isActive('bulletList'))} disabled={disabled}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        title={t('docEdit.bulletList')}
      ><IList className="w-4 h-4" /></button>
      <button
        type="button" className={btn(editor.isActive('orderedList'))} disabled={disabled}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        title={t('docEdit.orderedList')}
      ><IListOrdered className="w-4 h-4" /></button>
      <button
        type="button" className={btn(editor.isActive('blockquote'))} disabled={disabled}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        title={t('docEdit.quote')}
      ><IQuote className="w-4 h-4" /></button>
      <ToolbarSep />
      <button
        type="button" className={btn(editor.isActive('code'))} disabled={disabled}
        onClick={() => editor.chain().focus().toggleCode().run()}
        title={t('docEdit.inlineCode')}
      ><ICode className="w-4 h-4" /></button>
      <button
        type="button" className={btn(editor.isActive('codeBlock'))} disabled={disabled}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        title={t('docEdit.codeBlock')}
      ><ICodeBlock className="w-4 h-4" /></button>
      <LinkButton editor={editor} disabled={disabled} />
      <ImageButton editor={editor} disabled={disabled} />
      <ToolbarSep />
      <button
        type="button" className={btn(false)} disabled={disabled || !editor.can().undo()}
        onClick={() => editor.chain().focus().undo().run()}
        title={t('docEdit.undo')}
      ><IUndo className="w-4 h-4" /></button>
      <button
        type="button" className={btn(false)} disabled={disabled || !editor.can().redo()}
        onClick={() => editor.chain().focus().redo().run()}
        title={t('docEdit.redo')}
      ><IRedo className="w-4 h-4" /></button>
    </div>
  )
}

function ToolbarSep() {
  return <span className="w-px h-5 bg-stone-200 mx-1" />
}

function ImageButton({ editor, disabled }: { editor: Editor; disabled: boolean }) {
  const t = useT()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [uploading, setUploading] = useState(false)
  const insertImage = (attrs: { src: string; alt?: string; storageKey?: string | null }) => {
    const chain = editor.chain().focus()
    if (editor.isActive('image')) {
      chain.updateAttributes('image', attrs).run()
    } else {
      chain.setImage(attrs).run()
    }
  }
  const uploadAndInsert = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      alert(t('docEdit.chooseImageFile'))
      return
    }
    setUploading(true)
    try {
      const attachment = await api.uploadFile(file)
      if (attachment.kind !== 'img') throw new Error(t('docEdit.uploadedNotImage'))
      insertImage({ src: attachment.url, alt: attachment.name, storageKey: attachment.key ?? null })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('[docs] image upload failed', msg)
      alert(t('docEdit.uploadFailed', { msg }))
    } finally {
      setUploading(false)
    }
  }
  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void uploadAndInsert(file)
        }}
      />
      <button
        type="button"
        disabled={disabled || uploading}
        onClick={(event) => {
          if (event.altKey) {
            const existing = editor.getAttributes('image') as { src?: string; alt?: string }
            const input = prompt(t('docEdit.imageUrlPrompt'), existing.src ?? '')
            if (input === null) return
            const url = input.trim()
            if (!url || !isSafeImageUrl(url)) {
              alert(t('docEdit.imageUrlInvalid'))
              return
            }
            const altInput = prompt(t('docEdit.altTextPrompt'), existing.alt ?? '')
            if (altInput === null) return
            const alt = altInput.trim()
            insertImage(alt ? { src: url, alt } : { src: url })
            return
          }
          fileRef.current?.click()
        }}
        className={cn(
          'w-8 h-8 grid place-items-center rounded-md transition-colors',
          disabled || uploading ? 'text-stone-300' : (
            editor.isActive('image')
              ? 'bg-skype/15 text-skype-deep'
              : 'text-stone-600 hover:bg-stone-100'
          ),
        )}
        title={uploading ? t('docEdit.uploadingImage') : t('docEdit.insertImage')}
      >
        <IImage className="w-4 h-4" />
      </button>
    </>
  )
}

function LinkButton({ editor, disabled }: { editor: Editor; disabled: boolean }) {
  const t = useT()
  const isActive = editor.isActive('link')
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        const existing = editor.getAttributes('link').href as string | undefined
        const input = prompt(t('docEdit.linkPrompt'), existing ?? '')
        if (input === null) return
        const url = input.trim()
        if (!url) {
          editor.chain().focus().extendMarkRange('link').unsetLink().run()
        } else {
          editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
        }
      }}
      className={cn(
        'w-8 h-8 grid place-items-center rounded-md transition-colors',
        disabled ? 'text-stone-300' : (
          isActive
            ? 'bg-skype/15 text-skype-deep'
            : 'text-stone-600 hover:bg-stone-100'
        ),
      )}
      title={t('docEdit.link')}
    >
      <ILink className="w-4 h-4" />
    </button>
  )
}

/* ============== Presence ============== */

interface PeerInfo { clientId: number; name: string; color: string }

function PresenceStrip({ session, synced }: { session: YDocSession; synced: boolean }) {
  const t = useT()
  const [peers, setPeers] = useState<PeerInfo[]>([])
  useEffect(() => {
    const refresh = () => {
      const out: PeerInfo[] = []
      session.awareness.getStates().forEach((state, clientId) => {
        if (clientId === session.doc.clientID) return
        const u = (state as { user?: { name: string; color: string } }).user
        if (!u) return
        out.push({ clientId, name: u.name, color: u.color })
      })
      setPeers(out)
    }
    session.awareness.on('change', refresh)
    refresh()
    return () => session.awareness.off('change', refresh)
  }, [session])

  // `block` matters: an inline span's box height comes from the font's
  // ascent/descent (16.5px for 12px Manrope), not line-height, so it
  // centers on a different baseline than the 12px-tall Delete button.
  // As a block, height = leading-none line-height = 12px = same box.
  if (!synced) return <span className="block text-xs leading-none text-stone-400">{t('docEdit.syncing')}</span>
  if (peers.length === 0) return <span className="block text-xs leading-none text-stone-400">{t('docEdit.onlyYou')}</span>
  return (
    <div className="flex items-center -space-x-1.5">
      {peers.slice(0, 6).map((p) => (
        <div
          key={p.clientId}
          title={p.name}
          className="w-6 h-6 rounded-full border-2 border-white text-white text-[10px] flex items-center justify-center font-medium"
          style={{ background: p.color }}
        >
          {p.name.slice(0, 1).toUpperCase()}
        </div>
      ))}
      {peers.length > 6 && (
        <div className="w-6 h-6 rounded-full bg-stone-200 text-stone-600 text-[10px] flex items-center justify-center font-medium border-2 border-white">
          +{peers.length - 6}
        </div>
      )}
    </div>
  )
}

// Silence unused import warning — Y types come in through extensions.
void Y

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Vite proxy target. Default points at the local dev server; set
// CUMORA_DEV_API_TARGET=https://api.cumora.ai (no trailing slash) to
// run the dev renderer against production without rebuilding.
const HTTP_TARGET = process.env.CUMORA_DEV_API_TARGET || 'http://localhost:5181'
const WS_TARGET = HTTP_TARGET.replace(/^http/, 'ws')

export default defineConfig({
  plugins: [react()],
  // The renderer uses relative URLs through the Vite proxy, but commands
  // copied from the UI run outside that proxy and need the API origin.
  define: {
    'import.meta.env.VITE_CUMORA_DEV_API_TARGET': JSON.stringify(HTTP_TARGET),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    // yjs and prosemirror rely on instanceof checks across packages
    // (y-prosemirror decorations, tiptap extensions). If Vite's dep
    // optimizer ever splits them into more than one chunk instance —
    // which happened when @tiptap/extension-table was added — the editor
    // crashes with "Yjs was already imported" + `localsInner` TypeErrors.
    // Force a single module instance for each.
    dedupe: ['yjs', 'y-prosemirror', 'prosemirror-model', 'prosemirror-state', 'prosemirror-view', 'prosemirror-transform'],
  },
  optimizeDeps: {
    // Pre-bundle the yjs/prosemirror family as shared entries so every
    // tiptap extension chunk imports the SAME module instance (see
    // resolve.dedupe above — both are needed: dedupe fixes source-level
    // resolution, include fixes the dep-optimizer's chunk graph).
    include: [
      'yjs',
      '@tiptap/pm/model', '@tiptap/pm/state', '@tiptap/pm/view',
      '@tiptap/react', '@tiptap/starter-kit', '@tiptap/extension-table',
      '@tiptap/extension-collaboration', '@tiptap/extension-collaboration-caret',
    ],
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api':      { target: HTTP_TARGET, changeOrigin: true, secure: false },
      '/uploads':  { target: HTTP_TARGET, changeOrigin: true, secure: false },
      '/ws':       { target: WS_TARGET,   ws: true,           secure: false },
    },
  },
})

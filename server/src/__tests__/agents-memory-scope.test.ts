/**
 * Project-scoped memory contract (issue #45). Pure helpers — no Postgres,
 * no Redis. Cloud `loadMemory` and the BYOA `memoryDigest` both call these.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-memory-scope.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GLOBAL_MEMORY_INDEX,
  asMemorySource,
  buildMemoryMeta,
  buildMemorySource,
  clipMemoryDigest,
  composeMemoryDigest,
  conversationHeader,
  filterMemories,
  memoryIndexPathsForScope,
  memoryVisibleInScope,
  memoryWritePath,
  parseMemoryPath,
  pickWriteProvenance,
  projectIdFromMemoryPath,
  projectMemoryIndexPath,
  rowProjectId,
  uniqueProjectIds,
} from '../agents/memory-scope.js'

const P = 'proj-paper'
const Q = 'proj-ppt'
const scopeP = { projectIds: [P] }
const scopeQ = { projectIds: [Q] }
const scopeNone = { projectIds: [] as string[] }
const scopeBoth = { projectIds: [P, Q] }

const pinned = { pinned: true, source: { conversationId: 'c-a', projectId: P } }
const globalLegacy = { pinned: false, source: null }
const globalExplicit = { pinned: false, source: { conversationId: 'c-x', projectId: null } }
const workP = { pinned: false, source: { conversationId: 'c-a', projectId: P } }
const workQ = { pinned: false, source: { conversationId: 'c-b', projectId: Q } }

// ── truth table ────────────────────────────────────────────────────────

test('pinned memory is visible in every scope, including no-project', () => {
  assert.equal(memoryVisibleInScope(pinned, 'memory/note/p.md', scopeP), true)
  assert.equal(memoryVisibleInScope(pinned, 'memory/note/p.md', scopeQ), true)
  assert.equal(memoryVisibleInScope(pinned, 'memory/note/p.md', scopeNone), true)
  assert.equal(memoryVisibleInScope(pinned, 'memory/projects/' + P + '/note/p.md', scopeQ), true)
})

test('legacy source:null (all existing memories) stays GLOBAL', () => {
  assert.equal(memoryVisibleInScope(globalLegacy, 'memory/note/old.md', scopeP), true)
  assert.equal(memoryVisibleInScope(globalLegacy, 'memory/note/old.md', scopeNone), true)
  assert.equal(memoryVisibleInScope(undefined, 'memory/MEMORY.md', scopeQ), true)
})

test('unpinned write with null projectId is GLOBAL', () => {
  assert.equal(memoryVisibleInScope(globalExplicit, 'memory/fact/n.md', scopeP), true)
  assert.equal(memoryVisibleInScope(globalExplicit, 'memory/fact/n.md', scopeNone), true)
})

test('unpinned project-P work is visible only when P is in scope', () => {
  assert.equal(memoryVisibleInScope(workP, 'memory/decision/d.md', scopeP), true)
  assert.equal(memoryVisibleInScope(workP, 'memory/decision/d.md', scopeQ), false)
  assert.equal(memoryVisibleInScope(workP, 'memory/decision/d.md', scopeNone), false)
  assert.equal(memoryVisibleInScope(workP, 'memory/decision/d.md', scopeBoth), true)
})

test('path memory/projects/<id>/ is enough to scope even if meta.source is empty', () => {
  const pathP = 'memory/projects/' + P + '/note/x.md'
  assert.equal(memoryVisibleInScope({ pinned: false, source: null }, pathP, scopeP), true)
  assert.equal(memoryVisibleInScope({ pinned: false, source: null }, pathP, scopeQ), false)
  assert.equal(memoryVisibleInScope({ pinned: false, source: null }, pathP, scopeNone), false)
})

test('filterMemories drops other-project unpinned rows and keeps pinned + global', () => {
  const rows = [
    { path: 'memory/note/pin.md', meta: pinned },
    { path: 'memory/note/old.md', meta: globalLegacy },
    { path: 'memory/decision/p.md', meta: workP },
    { path: 'memory/decision/q.md', meta: workQ },
  ]
  const kept = filterMemories(rows, scopeP).map((r) => r.path)
  assert.deepEqual(kept, ['memory/note/pin.md', 'memory/note/old.md', 'memory/decision/p.md'])
  assert.deepEqual(
    filterMemories(rows, scopeNone).map((r) => r.path),
    ['memory/note/pin.md', 'memory/note/old.md'],
  )
})

// ── write provenance ───────────────────────────────────────────────────

test('pickWriteProvenance: path memory/projects/<id> wins', () => {
  const s = pickWriteProvenance({
    path: 'memory/projects/' + P + '/note/x.md',
    explicitProjectId: Q,
    thinking: [{ conversationId: 'c-b', projectId: Q }],
  })
  assert.equal(s.projectId, P)
})

test('pickWriteProvenance: explicit conversation + matching thinking row', () => {
  const s = pickWriteProvenance({
    explicitConversationId: 'c-a',
    thinking: [
      { conversationId: 'c-a', projectId: P },
      { conversationId: 'c-b', projectId: Q },
    ],
  })
  assert.deepEqual(s, { conversationId: 'c-a', projectId: P })
})

test('pickWriteProvenance: a single thinking conversation is unambiguous', () => {
  const s = pickWriteProvenance({
    thinking: [{ conversationId: 'c-a', projectId: P }],
  })
  assert.deepEqual(s, { conversationId: 'c-a', projectId: P })
})

test('pickWriteProvenance: several rooms of the SAME project stamp that project', () => {
  const s = pickWriteProvenance({
    thinking: [
      { conversationId: 'c-a', projectId: P },
      { conversationId: 'c-a2', projectId: P },
    ],
  })
  assert.equal(s.projectId, P)
  assert.equal(s.conversationId, null, 'two convos — do not pick one at random')
})

test('pickWriteProvenance: mixed projects fall back to GLOBAL (do not guess)', () => {
  const s = pickWriteProvenance({
    thinking: [
      { conversationId: 'c-a', projectId: P },
      { conversationId: 'c-b', projectId: Q },
    ],
  })
  assert.deepEqual(s, { conversationId: null, projectId: null })
})

test('pickWriteProvenance: no-project thinking conversation stays global', () => {
  const s = pickWriteProvenance({
    thinking: [{ conversationId: 'c-dm', projectId: null }],
  })
  assert.deepEqual(s, { conversationId: 'c-dm', projectId: null })
})

test('buildMemoryMeta records source instead of null', () => {
  const meta = buildMemoryMeta({
    path: 'memory/note/x.md',
    kind: 'note',
    conversationId: 'c-a',
    projectId: P,
  })
  assert.equal(meta.type, 'memory')
  assert.equal(meta.pinned, false)
  assert.deepEqual(meta.source, { conversationId: 'c-a', projectId: P })
})

test('memoryWritePath: global vs project layout', () => {
  assert.equal(memoryWritePath('fact', 'mem-1'), 'memory/fact/mem-1.md')
  assert.equal(memoryWritePath('fact', 'mem-1', P), 'memory/projects/' + P + '/fact/mem-1.md')
})

// ── path parsing / BYOA index selection ────────────────────────────────

test('parseMemoryPath understands both layouts', () => {
  assert.deepEqual(parseMemoryPath('memory/note/mem-abc.md'), {
    kind: 'note', id: 'mem-abc', projectId: null,
  })
  assert.deepEqual(parseMemoryPath('memory/projects/' + P + '/decision/mem-xyz.md'), {
    kind: 'decision', id: 'mem-xyz', projectId: P,
  })
  assert.deepEqual(parseMemoryPath(GLOBAL_MEMORY_INDEX), {
    kind: 'index', id: 'MEMORY', projectId: null,
  })
  assert.deepEqual(parseMemoryPath(projectMemoryIndexPath(P)), {
    kind: 'index', id: 'MEMORY', projectId: P,
  })
})

test('memoryIndexPathsForScope: existing MEMORY.md stays global; projects add their own', () => {
  assert.deepEqual(memoryIndexPathsForScope([]), [GLOBAL_MEMORY_INDEX])
  assert.deepEqual(memoryIndexPathsForScope([P]), [
    GLOBAL_MEMORY_INDEX,
    'memory/projects/' + P + '/MEMORY.md',
  ])
  assert.deepEqual(memoryIndexPathsForScope([P, P, Q]), [
    GLOBAL_MEMORY_INDEX,
    'memory/projects/' + P + '/MEMORY.md',
    'memory/projects/' + Q + '/MEMORY.md',
  ])
})

test('composeMemoryDigest: lone global index is byte-identical (clipped)', () => {
  const body = '• paper review is NOT in this file'
  assert.equal(
    composeMemoryDigest([{ label: GLOBAL_MEMORY_INDEX, body }]),
    body,
  )
})

test('composeMemoryDigest: concatenates global + current project only', () => {
  const digest = composeMemoryDigest([
    { label: GLOBAL_MEMORY_INDEX, body: 'I am nova.' },
    { label: projectMemoryIndexPath(P), body: 'paper-review decision: accept' },
    { label: projectMemoryIndexPath(Q), body: 'ppt deck outline' },
  ])
  assert.match(digest, /I am nova/)
  assert.match(digest, /paper-review decision: accept/)
  assert.match(digest, /ppt deck outline/)
  assert.match(digest, /## global/)
  assert.match(digest, new RegExp('## project ' + P))
})

test('clipMemoryDigest truncates with a recovery hint', () => {
  const out = clipMemoryDigest('abcdefghij', 4)
  assert.equal(out.startsWith('abcd'), true)
  assert.match(out, /truncated/)
})

test('conversationHeader: project-less is unchanged; Project: sits above Topic:', () => {
  assert.equal(
    conversationHeader({
      conversation_id: 'c1',
      conversation_kind: 'group',
      conversation_title: 'general',
      conversation_topic: 'chatter',
    }),
    '# c1 [group] "general"\n  Topic: chatter',
  )
  assert.equal(
    conversationHeader({
      conversation_id: 'c1',
      conversation_kind: 'group',
      conversation_title: 'papers',
      conversation_topic: 'review',
      project_name: 'Paper Review',
    }),
    '# c1 [group] "papers"\n  Project: Paper Review\n  Topic: review',
  )
})

test('uniqueProjectIds drops null/empty/dupes and preserves order', () => {
  assert.deepEqual(uniqueProjectIds([P, null, '', P, Q, undefined]), [P, Q])
})

test('rowProjectId prefers meta over path', () => {
  assert.equal(rowProjectId(workP, 'memory/note/x.md'), P)
  assert.equal(rowProjectId(null, 'memory/projects/' + Q + '/note/x.md'), Q)
  assert.equal(rowProjectId(globalLegacy, 'memory/note/x.md'), null)
})

test('buildMemorySource defaults both fields to null (global)', () => {
  assert.deepEqual(buildMemorySource({}), { conversationId: null, projectId: null })
})

test('projectIdFromMemoryPath ignores non-project memory paths', () => {
  assert.equal(projectIdFromMemoryPath('memory/note/x.md'), null)
  assert.equal(projectIdFromMemoryPath('skills/foo/SKILL.md'), null)
})

test('asMemorySource fills missing fields with null', () => {
  assert.deepEqual(asMemorySource(undefined), null)
  assert.deepEqual(asMemorySource({}), { conversationId: null, projectId: null })
  assert.deepEqual(asMemorySource({ projectId: P }), { conversationId: null, projectId: P })
})

test('no-project / empty scope list hides unpinned project work (memory list default)', () => {
  assert.equal(memoryVisibleInScope(workP, 'memory/decision/d.md', scopeNone), false)
  assert.equal(memoryVisibleInScope(workQ, 'memory/decision/q.md', scopeNone), false)
  assert.equal(memoryVisibleInScope(globalLegacy, 'memory/note/old.md', scopeNone), true)
  assert.equal(memoryVisibleInScope(pinned, 'memory/note/p.md', scopeNone), true)
})

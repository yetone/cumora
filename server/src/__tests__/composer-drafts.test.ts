/**
 * Composer draft persistence policy.
 *
 * The bug these pin: desktop kept drafts in component state, and DesktopApp
 * mounts views conditionally — so switching to Boards unmounted ChatPane and
 * a half-typed message was gone. Mobile had already learned this and moved
 * drafts into the store; desktop had drifted. Both now share this module, and
 * it mirrors to localStorage so a reload can't lose a draft either.
 *
 * The module is deliberately free of store/DOM imports so the policy can be
 * tested directly — these are the rules, not an approximation of them.
 *
 * Run: node --import tsx --test server/src/__tests__/composer-drafts.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_DRAFT, MAX_DRAFTS, MAX_SERIALIZED_BYTES,
  applyDraftUpdate, evict, isEmptyDraft, parseStoredDrafts, serializeDrafts,
  type ComposerDrafts,
} from '../../../src/stores/composerDrafts.js'

const att = { url: 'https://cdn.example/x.pdf', name: 'x.pdf', kind: 'pdf' as const }

// ── the survival contract ───────────────────────────────────────────────────

test('a draft written for one scope is readable back from the same map', () => {
  const next = applyDraftUpdate({}, 'convo-1', (d) => ({ ...d, text: 'half typed' }))
  assert.equal(next['convo-1'].text, 'half typed')
})

test('a thread composer does not share text with its conversation', () => {
  // The desktop thread drawer is a second composer over the same conversation.
  let d: ComposerDrafts = {}
  d = applyDraftUpdate(d, 'convo-1', (c) => ({ ...c, text: 'main' }))
  d = applyDraftUpdate(d, 'convo-1::thread::m-9', (c) => ({ ...c, text: 'thread' }))
  assert.equal(d['convo-1'].text, 'main')
  assert.equal(d['convo-1::thread::m-9'].text, 'thread')
})

test('multiple attachments ride along with the text in order', () => {
  // Dropping it would strand a file the user already uploaded.
  const second = { ...att, name: 'y.pdf', url: 'https://cdn.example/y.pdf' }
  const d = applyDraftUpdate({}, 'c', (c) => ({ ...c, attachments: [att, second] }))
  assert.deepEqual(d.c.attachments, [att, second])
  assert.equal(d.c.text, '')
})

// ── emptiness + identity ────────────────────────────────────────────────────

test('emptying a draft deletes it rather than leaving a tombstone', () => {
  // Otherwise every conversation ever opened would hold a MAX_DRAFTS slot.
  const one = applyDraftUpdate({}, 'c', (d) => ({ ...d, text: 'x' }))
  const gone = applyDraftUpdate(one, 'c', () => EMPTY_DRAFT)
  assert.equal('c' in gone, false)
})

test('clearing text but keeping an attachment keeps the draft', () => {
  let d = applyDraftUpdate({}, 'c', (c) => ({ text: 'x', attachments: [att] }))
  d = applyDraftUpdate(d, 'c', (c) => ({ ...c, text: '' }))
  assert.deepEqual(d.c, { text: '', attachments: [att] })
})

test('an unchanged update returns the SAME object', () => {
  // Identity is what lets the store skip both a re-render and a storage write.
  const d = applyDraftUpdate({}, 'c', (x) => ({ ...x, text: 'x' }))
  assert.equal(applyDraftUpdate(d, 'c', (x) => ({ ...x, text: 'x' })), d)
})

test('emptying an already-absent scope returns the SAME object', () => {
  const d: ComposerDrafts = {}
  assert.equal(applyDraftUpdate(d, 'never-typed', () => EMPTY_DRAFT), d)
})

// ── eviction ────────────────────────────────────────────────────────────────

test('the map is capped and evicts the least recently touched', () => {
  let d: ComposerDrafts = {}
  for (let i = 0; i < MAX_DRAFTS + 5; i++) {
    d = applyDraftUpdate(d, `c-${i}`, (c) => ({ ...c, text: `draft ${i}` }))
  }
  assert.equal(Object.keys(d).length, MAX_DRAFTS)
  assert.equal('c-0' in d, false, 'oldest should be gone')
  assert.equal(`c-${MAX_DRAFTS + 4}` in d, true, 'newest should be kept')
})

test('touching an old draft protects it from eviction', () => {
  // Ordering IS the LRU record, so an update has to move the key to the end.
  let d: ComposerDrafts = {}
  d = applyDraftUpdate(d, 'old', (c) => ({ ...c, text: 'keep me' }))
  for (let i = 0; i < MAX_DRAFTS - 1; i++) {
    d = applyDraftUpdate(d, `f-${i}`, (c) => ({ ...c, text: 'x' }))
  }
  d = applyDraftUpdate(d, 'old', (c) => ({ ...c, text: 'still typing' }))
  for (let i = 0; i < 5; i++) {
    d = applyDraftUpdate(d, `g-${i}`, (c) => ({ ...c, text: 'x' }))
  }
  assert.equal(d.old?.text, 'still typing')
})

// ── what comes back from storage is not trusted ─────────────────────────────

test('a round trip preserves text and ordered attachments', () => {
  const second = { ...att, name: 'y.pdf', url: 'https://cdn.example/y.pdf' }
  const d = applyDraftUpdate({}, 'c', () => ({ text: 'hello', attachments: [att, second] }))
  assert.deepEqual(parseStoredDrafts(serializeDrafts(d)), d)
})

test('a legacy single-attachment draft is migrated to an array', () => {
  const raw = JSON.stringify({ c: { text: 'hello', attachment: att } })
  assert.deepEqual(parseStoredDrafts(raw), { c: { text: 'hello', attachments: [att] } })
})

test('garbage in storage yields no drafts instead of throwing', () => {
  for (const raw of [null, '', 'not json', '[]', '"str"', '3', '{"c":null}', '{"c":5}']) {
    assert.deepEqual(parseStoredDrafts(raw), {}, JSON.stringify(raw))
  }
})

test('a malformed legacy attachment is dropped, not replayed into the composer', () => {
  // This value is handed to the send path; a half-parsed one must not survive.
  const raw = JSON.stringify({ c: { text: 'hi', attachment: { url: 'u' } } })   // no name/kind
  assert.deepEqual(parseStoredDrafts(raw), { c: { text: 'hi', attachments: [] } })
})

test('an unknown attachment kind is rejected', () => {
  const raw = JSON.stringify({ c: { text: 't', attachment: { ...att, kind: 'exe' } } })
  assert.deepEqual(parseStoredDrafts(raw).c.attachments, [])
})

test('stored entries that decode to empty are not resurrected', () => {
  assert.deepEqual(parseStoredDrafts(JSON.stringify({ c: { text: '', attachment: null } })), {})
})

// ── the storage mirror stays a guest in localStorage ────────────────────────

test('serialization stays under the byte ceiling by dropping oldest drafts', () => {
  let d: ComposerDrafts = {}
  for (let i = 0; i < 12; i++) {
    d = applyDraftUpdate(d, `c-${i}`, (c) => ({ ...c, text: 'x'.repeat(40_000) }))
  }
  const json = serializeDrafts(d)
  assert.ok(json !== null)
  assert.ok(json.length <= MAX_SERIALIZED_BYTES, `got ${json.length}`)
  const back = parseStoredDrafts(json)
  assert.ok('c-11' in back, 'the newest draft must survive the trim')
})

test('a single draft too large for the ceiling yields null rather than a partial write', () => {
  const d = applyDraftUpdate({}, 'c', (c) => ({ ...c, text: 'x'.repeat(MAX_SERIALIZED_BYTES + 10) }))
  assert.equal(serializeDrafts(d), null)
})

test('evict is a no-op below the cap and preserves identity', () => {
  const d = applyDraftUpdate({}, 'c', (x) => ({ ...x, text: 'x' }))
  assert.equal(evict(d), d)
})

test('isEmptyDraft only calls a draft empty when both halves are', () => {
  assert.equal(isEmptyDraft({ text: '', attachments: [] }), true)
  assert.equal(isEmptyDraft({ text: ' ', attachments: [] }), false)
  assert.equal(isEmptyDraft({ text: '', attachments: [att] }), false)
})

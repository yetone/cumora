/**
 * The BYOA daemon drops an agent's engine session id when — and only when —
 * carrying it forward would keep failing. Getting that verdict wrong is
 * expensive in one direction: a needless reset throws away the `--resume`
 * target that exists to recover the context an interrupted long task was
 * building (see SESSIONS_DIR in daemon.ts).
 *
 * These pin the "stale resume target" half of that verdict against the shape
 * the daemon actually sees: `failurePreview` (engine.ts) embeds the tail of the
 * engine's STDOUT in the error text, and on the Claude path that stdout is
 * stream-json whose every event line carries a `session_id` field.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-session-reset.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { engineDiagnosticProse, isStaleResumeError } from '../agents/computer/daemon.js'

/** A mid-turn death exactly as ClaudeSession.die() reports it: the process is
 *  gone (OOM / laptop sleep / provider hangup) and the last stream-json lines of
 *  the turn ride along as the failure preview. The session on the engine side is
 *  intact and resumable — this must NOT be read as a stale resume target. */
const MID_TURN_DEATH = [
  'local claude failed (exit 137): process exited with code 137',
  '{"type":"system","subtype":"init","session_id":"6f1c2e30-2b77-4a3f-9d51-4c0a1b2e3f44","tools":["Bash"]}',
  '{"type":"assistant","session_id":"6f1c2e30-2b77-4a3f-9d51-4c0a1b2e3f44","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":812,"output_tokens":64},"content":[{"type":"text","text":"Reading the inbox now."}]}}',
  '{"type":"user","session_id":"6f1c2e30-2b77-4a3f-9d51-4c0a1b2e3f44","message":{"role":"user","content":[{"type":"tool_result","content":"cumora messages conversationId=convo-42 --tail 30"}]}}',
].join('\n')

test('a mid-turn engine death is NOT a stale resume target (session id must survive)', () => {
  // The regression: every stream-json line carries `session_id`, and the agent's
  // own shim commands mention `conversationId` — so a noun-only match reported a
  // dead resume target on every crash and discarded the recoverable session.
  assert.equal(isStaleResumeError(MID_TURN_DEATH), false)
})

test('a mid-turn death whose transcript quotes resume wording still is NOT stale', () => {
  // The agent was writing *about* sessions when the process died. Its transcript
  // is not an engine diagnosis.
  const err = MID_TURN_DEATH +
    '\n{"type":"assistant","session_id":"6f1c2e30","message":{"model":"claude-sonnet-4-6","content":[{"type":"text","text":"No conversation found with session ID — that is the error we should handle."}]}}'
  assert.equal(isStaleResumeError(err), false)
})

test("a successful turn's own answer is never read as an engine diagnosis", () => {
  // `result` is prose only when is_error is true; on a clean turn it is the
  // agent's answer, which may legitimately discuss missing sessions.
  const err = 'local claude failed (exit 1): process exited with code 1\n' +
    '{"type":"result","is_error":false,"session_id":"6f1c2e30","result":"I could not resume the old session, so I started over."}'
  assert.equal(isStaleResumeError(err), false)
})

// ── genuinely stale resume targets still reset ───────────────────────────────

test('Claude: "No conversation found with session ID" IS a stale resume target', () => {
  const err = 'local claude failed (exit 1): process exited with code 1\n' +
    'No conversation found with session ID: 6f1c2e30-2b77-4a3f-9d51-4c0a1b2e3f44'
  assert.equal(isStaleResumeError(err), true)
})

test('a stale resume target reported inside a FAILED result event still resets', () => {
  // Same verdict whether the engine puts it on stderr or in an error event.
  const err = 'local claude failed (exit 1): process exited with code 1\n' +
    '{"type":"result","subtype":"error","is_error":true,"session_id":"6f1c2e30","result":"No conversation found with session ID: 6f1c2e30"}'
  assert.equal(isStaleResumeError(err), true)
})

test('codex: a thread/resume rejection IS a stale resume target', () => {
  const err = 'local codex failed (exit 1): thread/resume failed (thread not found)'
  assert.equal(isStaleResumeError(err), true)
})

test('other stale-target phrasings are recognized', () => {
  for (const phrase of [
    'Error: session not found',
    'Error: invalid session id',
    'Error: unknown conversation',
    'Error: could not resume this conversation',
    'Error: unable to resume — thread has expired',
    'Error: no such session',
  ]) {
    assert.equal(isStaleResumeError(`local claude failed (exit 1): ${phrase}`), true, phrase)
  }
})

test('a PLURAL miss is a stale resume target too', () => {
  // gemini exits fatally on `--resume <uuid>` once its per-project chats dir is
  // gone, and says so in the plural. Read as "not stale", the daemon keeps the
  // dead id and hands it back on the next wake — and the one after that. The
  // agent never runs again, which is worse than losing its context.
  for (const phrase of [
    'Error resuming session: No previous sessions found for this project.',
    'Error: sessions not found',
    'Error: invalid sessions',
    'Error: those threads do not exist',
  ]) {
    assert.equal(isStaleResumeError(`local gemini failed (exit 1): ${phrase}`), true, phrase)
  }
})

test('the singular phrasings every other engine uses still match', () => {
  // The plural allowance must not have moved the boundary for anyone else.
  for (const phrase of [
    'No conversation found with session ID: abc',
    'Error: session does not exist',
    'Error: conversation no longer exists',
  ]) {
    assert.equal(isStaleResumeError(`local claude failed (exit 1): ${phrase}`), true, phrase)
  }
})

test('a plural noun without failure wording is still not a diagnosis', () => {
  // The guard that matters: "sessions" alone proves nothing. Only the paired
  // failure wording does.
  for (const phrase of [
    'process exited with code 137',
    'wrote 3 sessions to disk',
    'listing sessions for this project',
  ]) {
    assert.equal(isStaleResumeError(`local gemini failed (exit 1): ${phrase}`), false, phrase)
  }
})

test('an ordinary crash with no session wording is not a stale resume target', () => {
  assert.equal(isStaleResumeError('local claude failed (exit 143): process terminated by SIGTERM'), false)
})

// ── engineDiagnosticProse ────────────────────────────────────────────────────

test('engineDiagnosticProse drops event structure but keeps plain lines', () => {
  const prose = engineDiagnosticProse(MID_TURN_DEATH)
  assert.match(prose, /process exited with code 137/)
  assert.doesNotMatch(prose, /session_id/)
  assert.doesNotMatch(prose, /conversationId/)
})

test('engineDiagnosticProse keeps an error event\'s message', () => {
  const prose = engineDiagnosticProse('{"type":"error","session_id":"abc","error":{"message":"session not found"}}')
  assert.match(prose, /session not found/)
  assert.doesNotMatch(prose, /session_id/)
})

test('engineDiagnosticProse tolerates a truncated JSON line', () => {
  // failurePreview slices at 4000 chars and conciseError at 900 — the last line
  // is routinely cut mid-object.
  const prose = engineDiagnosticProse('process exited with code 1\n{"type":"assistant","session_id":"abc","mess')
  assert.match(prose, /process exited with code 1/)
  assert.doesNotMatch(prose, /session_id/)
})

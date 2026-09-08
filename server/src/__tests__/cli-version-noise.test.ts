/**
 * A CLI's reported version gates whether Cumora will run it in secure mode
 * (`SECURE_ENGINE_MIN_VERSIONS`: claude ≥ 2.1.248, codex ≥ 0.138.0), so reading
 * the WRONG number out of its output is a security question, not a cosmetic one.
 *
 * The probe merged stdout and stderr into one blob and took the first
 * version-shaped token in it. Warnings arrive first and routinely carry a
 * version:
 *
 *   npm warn EBADENGINE Unsupported engine {
 *     required: { node: '>=20.19.0' }
 *   }
 *   claude 2.0.9 (Claude Code)
 *
 * That read as `20.19.0`, cleared the 2.1.248 floor, and a Claude Code that
 * cannot be sandboxed was treated as one that can. The gate failed OPEN, which
 * is the direction that matters.
 *
 * Run: node --import tsx --test server/src/__tests__/cli-version-noise.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const { parseCliVersion, isCliVersionAtLeast, versionFromOutput } =
  await import('../agents/computer/cli-version.js')

const NPM_ENGINE_WARNING = [
  'npm warn EBADENGINE Unsupported engine {',
  "  required: { node: '>=20.19.0' },",
  "  current: { node: 'v18.20.4' }",
  '}',
].join('\n')

// ── the stream separation, which is the structural half ────────────────────

test('a stderr warning cannot outrank the version on stdout', () => {
  // The realistic shape: the CLI prints its version on stdout, the package
  // manager complains on stderr. Merging them let the complaint win.
  const out = { stdout: 'claude 2.0.9 (Claude Code)', stderr: NPM_ENGINE_WARNING, combined: '' }
  assert.equal(versionFromOutput(out), '2.0.9')
  assert.equal(isCliVersionAtLeast(versionFromOutput(out), '2.1.248'), false)
})

test('an engine that reports only on stderr is still read', () => {
  // stderr is a fallback, not ignored — some CLIs really do print there, and
  // dropping it would fail closed on a perfectly good engine.
  assert.equal(versionFromOutput({ stdout: '', stderr: 'some-cli 1.4.0', combined: '' }), '1.4.0')
})

test('nothing anywhere reports nothing, rather than guessing', () => {
  // The caller treats null as "could not verify", which fails closed at the
  // secure floor. That is the right answer here.
  assert.equal(versionFromOutput({ stdout: '', stderr: '', combined: '' }), null)
  assert.equal(isCliVersionAtLeast(null, '2.1.248'), false)
})

// ── the line filter, for warnings that land on stdout ───────────────────────

test('an npm warning on stdout does not become the version', () => {
  assert.equal(parseCliVersion(`${NPM_ENGINE_WARNING}\nclaude 2.0.9 (Claude Code)`), '2.0.9')
})

test('a node deprecation notice does not become the version', () => {
  assert.equal(
    parseCliVersion('(node:12345) [DEP0040] DeprecationWarning: punycode is deprecated. Use 6.1.0.\nclaude 2.0.9'),
    '2.0.9',
  )
})

test('warnings alone yield null instead of a borrowed number', () => {
  // Failing closed is the point: no version means the secure gate refuses.
  assert.equal(parseCliVersion(NPM_ENGINE_WARNING), null)
  assert.equal(parseCliVersion('(node:1) [DEP0040] DeprecationWarning: use 6.1.0'), null)
})

// ── the shapes that already worked must keep working ───────────────────────

test('the ordinary version lines are unchanged', () => {
  assert.equal(parseCliVersion('1.2.3'), '1.2.3')
  assert.equal(parseCliVersion('claude 1.0.88 (Claude Code)'), '1.0.88')
  assert.equal(parseCliVersion('v2.10.0'), '2.10.0')
  assert.equal(parseCliVersion('codex-cli 0.5.1-alpha.2'), '0.5.1-alpha.2')
  assert.equal(parseCliVersion('2026.08.30'), '2026.08.30')
  assert.equal(parseCliVersion('no version here'), null)
  assert.equal(parseCliVersion(''), null)
  assert.equal(parseCliVersion(null), null)
})

test('a version whose own line merely contains the word warning still reads', () => {
  // The filter keys on how a line STARTS, so a CLI whose banner mentions
  // warnings in passing is not silenced.
  assert.equal(parseCliVersion('codex 0.152.0 — no warnings configured'), '0.152.0')
})

// ── and the gate itself, on the numbers that matter ────────────────────────

test('the secure floor still admits and refuses the right versions', () => {
  // 248 vs 9 has to compare numerically; a string compare would put 2.1.9 above
  // 2.1.248 and admit an engine a year too old.
  assert.equal(isCliVersionAtLeast('2.1.248', '2.1.248'), true)
  assert.equal(isCliVersionAtLeast('2.1.250', '2.1.248'), true)
  assert.equal(isCliVersionAtLeast('2.1.9', '2.1.248'), false)
  assert.equal(isCliVersionAtLeast('2.0.9', '2.1.248'), false)
  assert.equal(isCliVersionAtLeast('3.0.0', '2.1.248'), true)
  // A prerelease at the exact floor is below the release, per the doc comment.
  assert.equal(isCliVersionAtLeast('2.1.248-alpha.1', '2.1.248'), false)
})

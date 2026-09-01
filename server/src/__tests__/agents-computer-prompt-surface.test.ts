/**
 * The standing prompt has to describe the surface the agent actually has (#145).
 *
 * Secure mode removes the shell CLI on purpose — `<home>/bin` is never written,
 * `node` is not in the tool environment, no runtime URL or token crosses into
 * the model process — and gives the agent one MCP tool instead. Both secure
 * engines are shaped that way: Codex through `mcp_servers.cumora`, Claude
 * through `--tools …,mcp__cumora__cli` with Bash disallowed.
 *
 * Told to run `cumora` on its PATH, a secure agent spends the turn looking for
 * a binary that was deliberately withheld. The report describes exactly that:
 * it could reason and draft a reply, and could not publish it.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-prompt-surface.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  actionSurfaceFor, actionSurfaceText, calendarExampleText, postingMechanicsText,
} from '../agents/computer/prompt-surface.js'

test('secure mode gets the MCP tool, compatibility mode keeps the CLI', () => {
  // The switch is the unsandboxed opt-in itself, because that is exactly what
  // gates writing the shim into the model-visible <home>/bin.
  assert.equal(actionSurfaceFor(false), 'mcp')
  assert.equal(actionSurfaceFor(true), 'cli')
})

test('the secure prompt names the tool and forbids the hunt', () => {
  const text = actionSurfaceText('mcp')
  assert.match(text, /mcp__cumora__cli/)
  assert.match(text, /argv/)
  // The report's actual failure was the agent probing for these, one after
  // another, instead of using the tool it had.
  assert.match(text, /no `cumora` on\s+PATH/)
  assert.match(text, /no `node`/)
  assert.match(text, /no runtime URL or token/)
  assert.doesNotMatch(text, /CLI on your PATH/)
})

test('the compatibility prompt is unchanged', () => {
  // Operators who opted into unsandboxed BYOA do have the shim on PATH, and
  // nothing about their instructions should shift.
  assert.equal(actionSurfaceText('cli'), 'You act on Cumora through the `cumora` CLI on your PATH.\n\n')
})

test('secure posting advice does not point at the flag the bridge refuses', () => {
  // The sharper half of the bug. The MCP shim rejects these outright:
  //   "local file/stdin flags are unavailable; pass body text directly in argv"
  // so an agent that DID find the tool and followed the old prompt still failed.
  const text = postingMechanicsText('mcp')
  assert.match(text, /directly in argv/)
  assert.match(text, /Do NOT use/)
  assert.match(text, /`--file` or `--stdin`/)
  assert.doesNotMatch(text, /notes\/reply\.md/)
  assert.doesNotMatch(text, /SINGLE quotes/)
})

test('compatibility posting advice keeps the file route, which is right there', () => {
  const text = postingMechanicsText('cli')
  assert.match(text, /--file notes\/reply\.md/)
  assert.match(text, /the shell mangles/)
})

test('the secure calendar example is argv, not a quoted command line', () => {
  // Single quotes are load-bearing in the shell form and would arrive as
  // literal characters inside a calendar title through the bridge.
  const text = calendarExampleText('mcp', 'agent-ada')
  assert.match(text, /"argv":\["calendar","create"/)
  assert.match(text, /"agent-ada"/)
  assert.doesNotMatch(text, /'<chase>'/)
})

test('the compatibility calendar example still shell-quotes', () => {
  const text = calendarExampleText('cli', 'agent-ada')
  assert.match(text, /cumora calendar create '<chase>'/)
  assert.match(text, /--assignee agent-ada/)
})

test('neither surface leaves an unbalanced backtick in the prompt', () => {
  // These strings are stitched into one prompt full of `code spans`; an odd
  // count means a span swallows the rest of the paragraph in whatever renders
  // it, which is easy to do and invisible until someone reads the output.
  for (const text of [
    actionSurfaceText('cli'), actionSurfaceText('mcp'),
    postingMechanicsText('cli'), postingMechanicsText('mcp'),
    calendarExampleText('cli', 'a'), calendarExampleText('mcp', 'a'),
  ]) {
    const ticks = (text.match(/`/g) ?? []).length
    assert.equal(ticks % 2, 0, `unbalanced backticks (${ticks}) in: ${text}`)
  }
})

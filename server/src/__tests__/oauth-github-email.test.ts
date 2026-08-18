/**
 * Regression test for GitHub sign-in's email-selection logic.
 *
 * fetchProfile('github', ...) hits /user + /user/emails and picks a verified
 * address. A GitHub account can have its primary email unverified while a
 * secondary address is verified — that must still succeed and use the
 * verified secondary, not refuse outright (issue #2).
 *
 * Run: node --import tsx --test server/src/__tests__/oauth-github-email.test.ts
 */
import { test, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { fetchProfile } from '../oauth.js'
import { pool } from '../db/pool.js'

const SAVED_FETCH = globalThis.fetch

interface GitHubEmail { email: string; primary: boolean; verified: boolean }

function mockGitHub(user: { id: number; login: string; name?: string | null; avatar_url?: string }, emails: GitHubEmail[]) {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    if (href === 'https://api.github.com/user') {
      return new Response(JSON.stringify(user), { status: 200 })
    }
    if (href === 'https://api.github.com/user/emails') {
      return new Response(JSON.stringify(emails), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${href}`)
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = SAVED_FETCH
})

after(async () => {
  // oauth.ts imports both db/pool.js and redis.js, which open connections
  // at module load. Tear them down here so the test process can exit
  // instead of hanging on dangling handles.
  try { await pool.end() } catch { /* ignore */ }
  try {
    const { redis, sub } = await import('../redis.js')
    redis.disconnect()
    sub.disconnect()
  } catch { /* ignore */ }
})

test('fetchProfile(github): uses the primary email when it is verified', async () => {
  mockGitHub(
    { id: 1, login: 'octocat', name: 'The Octocat' },
    [{ email: 'primary@example.com', primary: true, verified: true }],
  )
  const profile = await fetchProfile('github', 'fake-token')
  assert.equal(profile.email, 'primary@example.com')
})

test('fetchProfile(github): falls back to a verified non-primary email when the primary is unverified', async () => {
  mockGitHub(
    { id: 2, login: 'alanthssss', name: null },
    [
      { email: 'unverified-primary@example.com', primary: true, verified: false },
      { email: 'verified-secondary@example.com', primary: false, verified: true },
    ],
  )
  const profile = await fetchProfile('github', 'fake-token')
  assert.equal(profile.email, 'verified-secondary@example.com')
  assert.equal(profile.displayName, 'alanthssss')
})

test('fetchProfile(github): still refuses when no email is verified at all', async () => {
  mockGitHub(
    { id: 3, login: 'nobody' },
    [{ email: 'unverified@example.com', primary: true, verified: false }],
  )
  await assert.rejects(
    () => fetchProfile('github', 'fake-token'),
    /github account has no verified email/,
  )
})

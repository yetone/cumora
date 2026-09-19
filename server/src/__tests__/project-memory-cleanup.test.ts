import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cleanupDeletedProjectMemories } from '../agents/computer/project-memory-cleanup.js'

test('local cleanup removes only the deleted project, and retries late writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-project-cleanup-'))
  try {
    const home = join(root, 'a-one')
    for (const path of ['memory/projects/p-delete', 'memory/projects/p-keep', 'skills']) {
      await mkdir(join(home, path), { recursive: true })
      await writeFile(join(home, path, 'note.md'), 'keep or delete')
    }
    await writeFile(join(home, 'memory/MEMORY.md'), 'global memory')
    const deletions = [{ projectId: 'p-delete', agentIds: ['a-one', 'a-offline'] }]
    await cleanupDeletedProjectMemories(root, deletions)
    await assert.rejects(readFile(join(home, 'memory/projects/p-delete/note.md')), { code: 'ENOENT' })
    assert.equal(await readFile(join(home, 'memory/MEMORY.md'), 'utf8'), 'global memory')
    assert.equal(await readFile(join(home, 'memory/projects/p-keep/note.md'), 'utf8'), 'keep or delete')
    assert.equal(await readFile(join(home, 'skills/note.md'), 'utf8'), 'keep or delete')
    // Simulate a still-running engine writing again before the next heartbeat.
    await mkdir(join(home, 'memory/projects/p-delete'), { recursive: true })
    await writeFile(join(home, 'memory/projects/p-delete/late.md'), 'late write')
    await cleanupDeletedProjectMemories(root, deletions)
    await cleanupDeletedProjectMemories(root, deletions)
    await assert.rejects(readFile(join(home, 'memory/projects/p-delete/late.md')), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('local cleanup rejects traversal and never follows an agent directory junction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-project-cleanup-'))
  try {
    const agents = join(root, 'agents')
    const outside = join(root, 'outside')
    await mkdir(agents)
    await mkdir(join(outside, 'memory/projects/p-delete'), { recursive: true })
    const note = join(outside, 'memory/projects/p-delete/note.md')
    await writeFile(note, 'preserve')
    await cleanupDeletedProjectMemories(agents, [
      { projectId: 'p-delete', agentIds: ['../outside', '..\\outside'] },
      { projectId: '../outside', agentIds: ['a-one'] },
    ])
    await symlink(outside, join(agents, 'a-link'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(cleanupDeletedProjectMemories(agents, [{ projectId: 'p-delete', agentIds: ['a-link'] }]))
    assert.equal(await readFile(note, 'utf8'), 'preserve')
  } finally { await rm(root, { recursive: true, force: true }) }
})

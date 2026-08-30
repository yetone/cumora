/**
 * Agent Skills — per-agent capability packs.
 *
 * Implements the Agent Skills spec (https://agentskills.io/specification)
 * on top of our existing `agent_workspace` virtual filesystem. Each
 * skill lives at `skills/<name>/SKILL.md` with optional sibling files
 * under `scripts/`, `references/`, `assets/`, etc.
 *
 * Progressive disclosure is the whole point: the wake prompt lists ONLY
 * each skill's `name` + `description` (~100 tokens per skill). The
 * agent runs `cumora skills read <name>` to pull the full SKILL.md
 * body into its next turn's context only when a task calls for it.
 * Bundled scripts / references / assets load on demand the same way
 * (`cumora skills read <name> <sub-path>`).
 *
 * Skills are PER-AGENT — Iris installing a skill doesn't give it to
 * Atlas, mirroring `agent_workspace` semantics. An agent who wants
 * a peer to learn the same skill messages them and they pull/create
 * the same files themselves.
 */
import { pool } from '../db/pool.js'

export interface SkillIndexEntry {
  name: string
  description: string
  /** Storage path under agent_workspace, e.g. `skills/pdf-tools/SKILL.md`. */
  path: string
}

export interface SkillFrontmatter {
  name: string
  description: string
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  'allowed-tools'?: string
}

/** Parse a SKILL.md body into `{ frontmatter, body }`. Returns
 *  `frontmatter: null` when the leading YAML block is missing or the
 *  required `name` / `description` fields aren't present.
 *
 *  Deliberately tiny — handles the subset of YAML the spec actually
 *  defines (scalar fields + a flat metadata mapping). For richer
 *  document trees we'd swap in `js-yaml`, but the spec doesn't need it. */
export function parseSkillMd(content: string): { frontmatter: SkillFrontmatter | null; body: string } {
  const normalized = content.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { frontmatter: null, body: normalized }
  const end = normalized.indexOf('\n---', 4)
  if (end < 0) return { frontmatter: null, body: normalized }
  const fmRaw = normalized.slice(4, end)
  const after = normalized.slice(end + 4).replace(/^\n/, '')

  const scalar = (raw: string): string => {
    let v = raw.trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    return v
  }

  const parsed: Partial<SkillFrontmatter> & { metadata?: Record<string, string> } = {}
  const lines = fmRaw.split('\n')
  let inMetadata = false
  for (const line of lines) {
    if (inMetadata) {
      // Indented key: value under metadata. Anything de-indented ends the block.
      const m = line.match(/^ {2,}([\w.-]+)\s*:\s*(.*)$/)
      if (m) {
        parsed.metadata = parsed.metadata ?? {}
        parsed.metadata[m[1]] = scalar(m[2])
        continue
      }
      inMetadata = false
    }
    if (!line.trim()) continue
    if (line.startsWith('metadata:')) {
      inMetadata = true
      parsed.metadata = parsed.metadata ?? {}
      continue
    }
    const m = line.match(/^([a-zA-Z][\w-]*)\s*:\s*(.*)$/)
    if (!m) continue
    const [, key, raw] = m
    if (key === 'name' || key === 'description' || key === 'license'
        || key === 'compatibility' || key === 'allowed-tools') {
      ;(parsed as Record<string, unknown>)[key] = scalar(raw)
    }
  }
  if (!parsed.name || !parsed.description) return { frontmatter: null, body: after }
  return { frontmatter: parsed as SkillFrontmatter, body: after }
}

/** Validate a skill `name` per the spec — 1-64 chars, lowercase a-z /
 *  0-9 / hyphens, no leading or trailing hyphen, no consecutive
 *  hyphens. Returns null on success, an error message otherwise. */
export function validateSkillName(name: string): string | null {
  if (!name) return 'name required'
  if (name.length < 1 || name.length > 64) return 'name length must be 1–64 characters'
  if (!/^[a-z0-9-]+$/.test(name)) return 'name may only contain lowercase a-z, 0-9, and hyphens'
  if (name.startsWith('-') || name.endsWith('-')) return 'name may not start or end with a hyphen'
  if (name.includes('--')) return 'name may not contain consecutive hyphens'
  return null
}

/** Shape of a skill returned by a SkillHub `/search` response. */
export interface SkillHubSearchHit {
  name: string
  description: string
  version?: string
  author?: string
  /** Optional hub metadata. Cumora deliberately does not fetch this URL:
   *  install requests are always rebuilt from the operator-configured hub
   *  plus the skill id, so an agent or a compromised search response cannot
   *  turn the server into an arbitrary HTTP client. */
  install_url?: string
}

/** Self-contained install manifest — the entire skill folder serialized
 *  as a flat file list. Paths are RELATIVE to the skill root, e.g.
 *  `SKILL.md`, `scripts/extract.py`, `references/REFERENCE.md`. */
export interface SkillManifest {
  name: string
  description: string
  version?: string
  author?: string
  files: Array<{ path: string; body: string }>
}

const HUB_TIMEOUT_MS = 10_000
const MAX_FILES_PER_SKILL = 100
const MAX_FILE_BODY_BYTES = 256 * 1024  // 256KB per file

/** Search a SkillHub by free-text query. Returns the hub's raw hit
 *  list — caller is responsible for rendering. Throws on transport or
 *  HTTP errors so the CLI can surface a useful message. */
export async function searchSkillHub(query: string, hubUrl: string): Promise<SkillHubSearchHit[]> {
  if (!hubUrl) throw new Error('SkillHub URL not configured — set SKILLHUB_URL on the server')
  const url = `${hubUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}`
  const r = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
  })
  if (!r.ok) throw new Error(`hub search failed: HTTP ${r.status}`)
  const json = await r.json()
  if (!Array.isArray(json)) throw new Error('hub search returned non-array')
  return json as SkillHubSearchHit[]
}

/** Resolve a skill id to a manifest on the operator-configured hub.
 *
 * Agent-controlled URLs are intentionally rejected. The server owns the
 * network destination; the agent controls only an encoded path segment.
 * Redirects are disabled as well, so a trusted-looking hub response cannot
 * pivot the request to metadata, loopback, or another internal service. */
export async function fetchSkillManifest(skillId: string, hubUrl: string): Promise<SkillManifest> {
  if (/^https?:\/\//i.test(skillId) || skillId.startsWith('//')) {
    throw new Error('explicit install URLs are not allowed — install by skill id from the configured SkillHub')
  }
  if (!hubUrl) throw new Error('SkillHub URL not configured — set SKILLHUB_URL')
  const url = `${hubUrl.replace(/\/+$/, '')}/skills/${encodeURIComponent(skillId)}`
  const r = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
  })
  if (!r.ok) throw new Error(`hub install failed: HTTP ${r.status}`)
  const json = await r.json() as Partial<SkillManifest>
  if (!json || typeof json !== 'object') throw new Error('manifest is not an object')
  if (!json.name || !json.description || !Array.isArray(json.files)) {
    throw new Error('manifest missing required fields (name, description, files[])')
  }
  return json as SkillManifest
}

/** Validate and write a manifest into an agent's workspace. Refuses to
 *  overwrite an existing skill of the same name — caller can delete
 *  first if they really want a clean reinstall. */
export async function installSkillFromManifest(args: {
  agentId: string
  manifest: SkillManifest
}): Promise<{ name: string; files: number }> {
  const { agentId, manifest } = args

  const nameError = validateSkillName(manifest.name)
  if (nameError) throw new Error(`skill name invalid: ${nameError}`)
  if (!manifest.description || manifest.description.length > 1024) {
    throw new Error('description must be 1–1024 chars')
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('manifest has no files')
  }
  if (manifest.files.length > MAX_FILES_PER_SKILL) {
    throw new Error(`too many files: ${manifest.files.length} > ${MAX_FILES_PER_SKILL}`)
  }
  // Must contain a SKILL.md at the root.
  const rootSkillFile = manifest.files.find((f) => f.path === 'SKILL.md')
  if (!rootSkillFile) {
    throw new Error('manifest must include SKILL.md at the skill root')
  }
  const rootParsed = parseSkillMd(rootSkillFile.body)
  if (!rootParsed.frontmatter) {
    throw new Error('SKILL.md has missing or malformed YAML frontmatter')
  }
  if (rootParsed.frontmatter.name !== manifest.name) {
    throw new Error(`manifest name "${manifest.name}" does not match SKILL.md frontmatter name "${rootParsed.frontmatter.name}"`)
  }

  const seenPaths = new Set<string>()
  // Path-traversal / size validation per file.
  for (const f of manifest.files) {
    if (typeof f.path !== 'string' || typeof f.body !== 'string') {
      throw new Error('every file needs string `path` and `body`')
    }
    if (f.path.length === 0 || f.path.length > 200) {
      throw new Error(`bad path length: ${f.path}`)
    }
    if (
      f.path.startsWith('/') ||
      f.path.startsWith('./') ||
      f.path.endsWith('/') ||
      f.path.includes('..') ||
      f.path.includes('/./') ||
      f.path.includes('//') ||
      /[\\:*?<>"|]/.test(f.path)
    ) {
      throw new Error(`unsafe path: ${f.path}`)
    }
    if (seenPaths.has(f.path)) {
      throw new Error(`duplicate file path in manifest: ${f.path}`)
    }
    seenPaths.add(f.path)
    if (Buffer.byteLength(f.body, 'utf8') > MAX_FILE_BODY_BYTES) {
      throw new Error(`file ${f.path} > ${MAX_FILE_BODY_BYTES} bytes`)
    }
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Don't clobber an existing skill — the agent decides whether to
    // delete the old one first.
    const { rows: existing } = await client.query<{ path: string }>(
      `SELECT path FROM agent_workspace WHERE agent_id = $1 AND path = $2 LIMIT 1 FOR UPDATE`,
      [agentId, `skills/${manifest.name}/SKILL.md`],
    )
    if (existing[0]) {
      throw new Error(`skill "${manifest.name}" already installed — \`cumora skills delete ${manifest.name}\` first if you want to reinstall`)
    }

    // Same tenant lookup the CLI's workspace writes do — without it
    // `agent_workspace.company_id` lands NULL and the Observability
    // panel (which filters by the user's company) can't see the files.
    const { rows: ag } = await client.query<{ company_id: string | null }>(
      `SELECT company_id FROM participants WHERE id = $1 LIMIT 1`, [agentId],
    )
    const tenant = ag[0]?.company_id ?? null

    let written = 0
    for (const f of manifest.files) {
      const path = `skills/${manifest.name}/${f.path}`
      await client.query(
        `INSERT INTO agent_workspace (agent_id, path, body, company_id, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (agent_id, path) DO UPDATE SET body = EXCLUDED.body, company_id = EXCLUDED.company_id, updated_at = NOW()`,
        [agentId, path, f.body, tenant],
      )
      written++
    }
    await client.query('COMMIT')
    return { name: manifest.name, files: written }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Load only `name` + `description` for each installed skill — the
 *  progressive-disclosure index that goes into the wake prompt. Skips
 *  any SKILL.md whose frontmatter is malformed (with a console warning
 *  so the agent can debug). */
export async function loadSkillsIndex(agentId: string): Promise<SkillIndexEntry[]> {
  const { rows } = await pool.query<{ path: string; body: string }>(
    `SELECT path, body FROM agent_workspace
      WHERE agent_id = $1 AND path LIKE 'skills/%/SKILL.md'
      ORDER BY path ASC`,
    [agentId],
  )
  const out: SkillIndexEntry[] = []
  for (const r of rows) {
    const { frontmatter } = parseSkillMd(r.body)
    if (!frontmatter) {
      console.warn(`[skills] ${agentId}: malformed SKILL.md at ${r.path} — skipped`)
      continue
    }
    out.push({ name: frontmatter.name, description: frontmatter.description, path: r.path })
  }
  return out
}

import { createHash } from 'node:crypto'
import { pool } from '../db/pool.js'
import {
  cloudComputerId,
  type ComputerKind,
  type EngineId,
  resolveComputerAssignment,
} from './computer/registry.js'

const AVATAR_PALETTE = [
  '#FFB088', '#FFD9D2', '#FFB7AF', '#F4B740',
  '#7C5CFF', '#A593FF', '#4FC2F4', '#41B5DC',
  '#4FC2A1', '#6EC56A', '#E9A0E9', '#FF7AB6',
] as const

export class AgentCreationError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export interface CreateAgentRecordInput {
  companyId: string
  tier: 'free' | 'pro' | 'max'
  maxActiveAgents: number
  requestId?: string | null
  name: string
  role?: string
  systemPrompt: string
  bio?: string
  initial?: string
  avatarBg?: string
  model?: string | null
  fastModel?: string | null
  tools?: string[]
  computerId?: string | null
  engine?: string
  inherit?: boolean
}

export interface CreateAgentRecordResult {
  id: string
  created: boolean
  placement: {
    kind: ComputerKind
    engine: EngineId
    inherit: boolean
  } | null
}

function slugifyAgentName(name: string): string {
  const lowered = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  let slug = lowered
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 24)
  if (!/^[a-z]/.test(slug)) slug = `a-${slug}`.slice(0, 24)
  if (slug.length === 0) slug = 'agent'
  return slug
}

function candidateAgentIds(name: string): string[] {
  const base = slugifyAgentName(name)
  return [
    base,
    ...Array.from({ length: 8 }, () => `${base}-${Math.random().toString(36).slice(2, 6)}`),
  ]
}

function defaultAvatarBg(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length]
}

function normalizeRequestId(value: string | null | undefined): string | null {
  if (value == null) return null
  const requestId = value.trim()
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) {
    throw new AgentCreationError(400, 'requestId must be 8-128 safe characters')
  }
  return requestId
}

function creationRequestHash(input: CreateAgentRecordInput): string {
  const canonical = JSON.stringify({
    name: input.name,
    role: input.role ?? '',
    systemPrompt: input.systemPrompt,
    bio: input.bio ?? '',
    initial: input.initial ?? '',
    avatarBg: input.avatarBg ?? '',
    model: input.model ?? null,
    fastModel: input.fastModel ?? null,
    tools: input.tools ?? ['bash'],
    computerId: input.computerId ?? null,
    engine: input.engine ?? null,
    inherit: input.inherit === true,
  })
  return createHash('sha256').update(canonical).digest('base64url')
}

/**
 * Persist an Agent and its initial Computer placement as one idempotent unit.
 *
 * Locking the company row serializes capacity checks and same-workspace
 * creation retries. The request id then turns an ambiguous HTTP retry into a
 * lookup of the already committed Agent instead of a second INSERT. Computer
 * validation uses a row lock in this same transaction, so revocation or an
 * invalid explicit engine pin rolls the whole create back.
 */
export async function createAgentRecord(
  input: CreateAgentRecordInput,
): Promise<CreateAgentRecordResult> {
  const requestId = normalizeRequestId(input.requestId)
  const requestHash = requestId ? creationRequestHash(input) : null
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const company = await client.query(
      'SELECT id FROM companies WHERE id = $1 FOR UPDATE',
      [input.companyId],
    )
    if (!company.rowCount) throw new AgentCreationError(404, 'company not found')

    if (requestId) {
      const { rows } = await client.query<{
        id: string
        creation_request_hash: string | null
        computer_id: string | null
        engine: EngineId | null
        engine_inherit: boolean
        kind: ComputerKind | null
      }>(
        `SELECT p.id, p.creation_request_hash, p.computer_id, p.engine,
                p.engine_inherit, c.kind
           FROM participants p
           LEFT JOIN computers c
             ON c.id = p.computer_id AND c.company_id = p.company_id
          WHERE p.company_id = $1 AND p.kind = 'agent'
            AND p.creation_request_id = $2
          LIMIT 1`,
        [input.companyId, requestId],
      )
      const existing = rows[0]
      if (existing) {
        if (existing.creation_request_hash !== requestHash) {
          throw new AgentCreationError(409, 'requestId was already used with different agent data')
        }
        await client.query('COMMIT')
        return {
          id: existing.id,
          created: false,
          placement: existing.computer_id && existing.kind && existing.engine
            ? { kind: existing.kind, engine: existing.engine, inherit: existing.engine_inherit }
            : null,
        }
      }
    }

    const { rows: countRows } = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM participants
        WHERE company_id = $1 AND kind = 'agent' AND departed_at IS NULL`,
      [input.companyId],
    )
    if ((countRows[0]?.count ?? 0) >= input.maxActiveAgents) {
      throw new AgentCreationError(
        403,
        `${input.tier} tier workspaces can have at most ${input.maxActiveAgents} active agents`,
      )
    }

    let placement: CreateAgentRecordResult['placement'] = null
    const computerId = input.computerId?.trim() || null
    if (computerId) {
      if (computerId === cloudComputerId(input.companyId) && input.tier === 'free') {
        throw new AgentCreationError(
          403,
          'Free tier agents run on your own computer. Upgrade to Pro to use Cumora Cloud.',
        )
      }
      placement = await resolveComputerAssignment({
        companyId: input.companyId,
        computerId,
        engine: input.engine,
        inherit: input.inherit,
        strictEngine: true,
      }, client)
      if (!placement) {
        throw new AgentCreationError(400, 'invalid computer or engine for this company')
      }
    }

    const tools = input.tools ?? ['bash']
    for (const agentId of candidateAgentIds(input.name)) {
      const initial = input.initial || input.name.charAt(0).toUpperCase()
      const avatarBg = input.avatarBg || defaultAvatarBg(agentId)
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO participants
           (id, kind, name, role, initial, avatar_bg, status, bio, tools,
            system_prompt, model, fast_model, company_id, computer_id, engine,
            engine_inherit, creation_request_id, creation_request_hash)
         VALUES
           ($1, 'agent', $2, $3, $4, $5, 'avail', $6, $7::jsonb,
            $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          agentId, input.name, input.role ?? '', initial, avatarBg, input.bio ?? '',
          JSON.stringify(tools), input.systemPrompt, input.model ?? null,
          input.fastModel ?? null, input.companyId, computerId,
          placement?.engine ?? null, placement?.inherit ?? true,
          requestId, requestHash,
        ],
      )
      if (rows[0]) {
        await client.query('COMMIT')
        return { id: rows[0].id, created: true, placement }
      }
    }

    throw new AgentCreationError(500, 'could not pick a unique agent id — please retry')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

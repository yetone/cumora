import { randomUUID } from 'node:crypto'
import { redis } from '../../redis.js'
import { ENGINE_UPDATE_TTL_SECONDS, type EngineUpdate } from '../../../../shared/engine-update.js'

interface EngineUpdateRecord extends EngineUpdate {
  companyId: string
  computerId: string
}

const jobKey = (id: string) => `cumora:engine-update:job:${id}`
const activeKey = (computerId: string) => `cumora:engine-update:active:${computerId}`

/** Reserve the whole computer: its daemon serializes global package updates. */
export async function startEngineUpdate(computerId: string, companyId: string, engine: string): Promise<EngineUpdateRecord | null> {
  const job: EngineUpdateRecord = { id: randomUUID(), computerId, companyId, engine, status: 'queued' }
  const reserved = await redis.set(activeKey(computerId), job.id, 'EX', ENGINE_UPDATE_TTL_SECONDS, 'NX')
  if (!reserved) return null
  try {
    await redis.set(jobKey(job.id), JSON.stringify(job), 'EX', ENGINE_UPDATE_TTL_SECONDS)
  } catch (error) {
    await releaseEngineUpdate(job).catch(() => {})
    throw error
  }
  return job
}

export async function getEngineUpdate(id: string): Promise<EngineUpdateRecord | null> {
  const raw = await redis.get(jobKey(id))
  return raw ? JSON.parse(raw) as EngineUpdateRecord : null
}

async function releaseEngineUpdate(job: EngineUpdateRecord): Promise<void> {
  await redis.eval(
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
    1, activeKey(job.computerId), job.id,
  )
}

/** Only the owning daemon may claim/finish this request. Claiming twice is refused. */
export async function reportEngineUpdate(
  computerId: string,
  id: string,
  status: 'running' | 'succeeded' | 'failed',
  error?: string,
): Promise<boolean> {
  const job = await getEngineUpdate(id)
  if (!job || job.computerId !== computerId) return false
  if (status !== 'running' && job.status === status) return true
  const expected = status === 'running' ? 'queued' : 'running'
  // An undelivered request can fail before a daemon claims it.
  if (job.status !== expected && !(status === 'failed' && job.status === 'queued')) return false
  const next = { ...job, status, ...(error ? { error: error.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000) } : {}) }
  const saved = await redis.eval(
    `local raw = redis.call('GET', KEYS[1])
     if not raw or raw ~= ARGV[1] then return 0 end
     redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
     if ARGV[4] ~= 'running' and redis.call('GET', KEYS[2]) == ARGV[5] then
       redis.call('DEL', KEYS[2])
     end
     return 1`,
    2, jobKey(id), activeKey(computerId),
    JSON.stringify(job), JSON.stringify(next), String(ENGINE_UPDATE_TTL_SECONDS), status, id,
  )
  return Boolean(saved)
}
